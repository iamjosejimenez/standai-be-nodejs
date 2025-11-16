import cors from "cors";
import express from "express";
import { config as loadEnv } from "dotenv";
import { DefaultAzureCredential } from "@azure/identity";
import { AIProjectClient } from "@azure/ai-projects";
import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { OpenAIInstrumentation } from "@opentelemetry/instrumentation-openai";
import { trace, SpanStatusCode, SpanKind } from "@opentelemetry/api";

loadEnv();

const settings = {
  projectEndpoint: process.env.PROJECT_ENDPOINT ?? "project_endpoint",
  agentId: process.env.AGENT_ID ?? "agent_id",
  feedbackAgentId:
    process.env.FEEDBACK_AGENT_ID ?? process.env.AGENT_ID ?? "agent_id",
  port: Number(process.env.PORT ?? 8000),
  corsOrigins: process.env.CORS_ORIGINS ?? "*",
};

const credential = new DefaultAzureCredential();
const projectClient = new AIProjectClient(settings.projectEndpoint, credential);

let tracer;
const telemetrySetup = (async () => {
  try {
    const connectionString =
      await projectClient.telemetry.getApplicationInsightsConnectionString();
    if (connectionString) {
      useAzureMonitor({ azureMonitorExporterOptions: { connectionString } });
    }
    registerInstrumentations({
      instrumentations: [
        new OpenAIInstrumentation({ captureMessageContent: true }),
      ],
    });

    tracer = trace.getTracer("joke-api");

    console.log("Azure Monitor / OpenTelemetry initialized.");
  } catch (error) {
    console.warn("Telemetry instrumentation failed:", error.message);
  }
})();

const app = express();

const corsOrigins =
  settings.corsOrigins === "*"
    ? "*"
    : settings.corsOrigins.split(",").map((origin) => origin.trim());

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
  }),
);

function withSpan(name, handler) {
  return async (req, res, next) => {
    await tracer.startActiveSpan(
      name,
      { kind: SpanKind.SERVER },
      async (span) => {
        try {
          await handler(req, res, next, span);
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error?.message ?? String(error),
          });
          span.recordException(error);
          next(error);
        } finally {
          span.end();
        }
      },
    );
  };
}

app.get(
  "/joke",
  withSpan("joke.run", async (req, res, next, span) => {
    try {
      const systemPrompt =
        "You are a standup comedian, return back only one joke. The user will either like or dislike the joke";
      const agent = await projectClient.agents.getAgent(settings.agentId);
      const thread = await projectClient.agents.threads.create();

      span.setAttribute("gen_ai.system", "azure_ai_projects");
      span.setAttribute("gen_ai.provider.name", "azure_ai_projects_agents");
      span.setAttribute("gen_ai.thread.id", thread.id);
      span.setAttribute("gen_ai.agent.id", agent.id);

      span.addEvent("gen_ai.system.message", {
        "gen_ai.event.content": JSON.stringify({
          message: systemPrompt,
          role: "system",
        }),
        "gen_ai.thread.id": thread.id,
      });

      await projectClient.agents.messages.create(
        thread.id,
        "assistant",
        systemPrompt,
      );

      const runPoller = projectClient.agents.runs.createAndPoll(
        thread.id,
        agent.id,
      );
      const run = await runPoller.pollUntilDone();

      if (run.id) {
        span.setAttribute("gen_ai.thread.run.id", run.id);
        span.setAttribute("gen_ai.response.id", `${thread.id}/${run.id}`);
      }

      const usage = run.usage;
      const inputTokens = usage.inputTokens ?? usage.input_tokens;
      const outputTokens = usage.outputTokens ?? usage.output_tokens;

      if (inputTokens != null) {
        span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
      }
      if (outputTokens != null) {
        span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
      }

      if (run.status === "failed") {
        console.error("Run failed", run.lastError);
        return res.status(500).json({
          error: "The agent run failed",
          details: run.lastError,
        });
      }

      const messageText = await getLatestAssistantMessageText(thread.id);

      span.addEvent("gen_ai.choice", {
        "gen_ai.event.content": JSON.stringify({
          message: messageText,
          role: "assistant",
        }),
        "gen_ai.thread.id": thread.id,
        "gen_ai.thread.run.id": run.id ?? "",
        "gen_ai.response.id": `${thread.id}/${run.id ?? ""}`,
      });

      span.setStatus({ code: SpanStatusCode.OK });

      res.json({
        message: messageText,
        threadId: thread.id,
      });
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error?.message ?? "Unhandled error in /joke",
      });
      next(error);
    }
  }),
);

app.get("/feedback", async (req, res, next) => {
  const { reaction, threadId } = req.query;

  if (!reaction || !threadId) {
    return res.status(400).json({
      error: "Both 'reaction' and 'threadId' query params are required",
    });
  }

  try {
    await projectClient.agents.messages.create(
      threadId,
      "assistant",
      `The result of the joke was: ${reaction}, return another joke based on this information`,
    );

    const agent = await projectClient.agents.getAgent(settings.feedbackAgentId);

    const runPoller = projectClient.agents.runs.createAndPoll(
      threadId,
      agent.id,
    );
    const run = await runPoller.pollUntilDone();

    if (run.status === "failed") {
      console.error("Run failed", run.lastError);
      return res.status(500).json({
        error: "The agent run failed",
        details: run.lastError,
      });
    }

    const messageText = await getLatestAssistantMessageText(threadId);

    res.json({
      message: messageText,
      threadId,
    });
  } catch (error) {
    next(error);
  }
});

async function getLatestAssistantMessageText(threadId) {
  const messages = projectClient.agents.messages.list(threadId, {
    order: "desc",
    limit: 20,
  });

  for await (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (const contentBlock of message.content) {
      if (contentBlock.type === "text" && contentBlock.text?.value) {
        return contentBlock.text.value;
      }
    }
  }

  throw new Error("No assistant response was found for this thread");
}

// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    error: "Internal Server Error",
    msg: error?.message ?? String(error),
  });
});

await telemetrySetup;

app.listen(settings.port, () => {
  console.log(`Server listening on port ${settings.port}`);
});
