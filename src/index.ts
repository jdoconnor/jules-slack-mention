import { SlackApp, SlackEdgeAppEnv } from "slack-cloudflare-workers";

const JULES_API_BASE = "https://jules.googleapis.com/v1alpha";

interface Env extends SlackEdgeAppEnv {
  USER_TOKENS: KVNamespace;
  SLACK_BOT_USER_ID: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/notion")) {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405 });
      }

      const body = await request.json() as any;
      const userId = body.triggeredByNotionUserId;

      if (!userId) {
        return new Response("Missing triggeredByNotionUserId", { status: 400 });
      }

      if (url.pathname === "/notion/token") {
        const token = body.token;
        if (!token) return new Response("Missing token", { status: 400 });
        await env.USER_TOKENS.put(`notion_token:${userId}`, token);
        return new Response(JSON.stringify({ message: "Notion token registered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/notion/repo") {
        const repo = body.repo;
        if (!repo) return new Response("Missing repo", { status: 400 });
        await env.USER_TOKENS.put(`notion_repo:${userId}`, repo);
        return new Response(JSON.stringify({ message: "Notion repo registered" }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (url.pathname === "/notion") {
        const text = body.text;
        if (!text) return new Response("Missing text", { status: 400 });

        const userToken = await env.USER_TOKENS.get(`notion_token:${userId}`);
        if (!userToken) {
          return new Response(JSON.stringify({ error: "No Jules token found. Register with /notion/token first." }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          });
        }

        try {
          const sources = await listJulesSources(userToken);
          if (!sources || sources.length === 0) {
            return new Response(JSON.stringify({ error: "No GitHub repositories found." }), {
              status: 404,
              headers: { "Content-Type": "application/json" }
            });
          }

          const storedRepo = await env.USER_TOKENS.get(`notion_repo:${userId}`);
          const source = selectSource(sources, storedRepo);
          const session = await createJulesSession(userToken, text, source.name);

          ctx.waitUntil(pollSessionAndLog(userToken, session.id));

          return new Response(JSON.stringify({
            message: "Jules session started",
            sessionId: session.id,
            title: session.title
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        } catch (error) {
          console.error(JSON.stringify({
            message: "failed to create notion jules session",
            error: error instanceof Error ? error.message : String(error),
            userId,
          }));
          return new Response(JSON.stringify({ error: "Failed to start Jules session" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
    }

    const app = new SlackApp({ env });

    app.command("/jules-token", async ({ payload }) => {
      const token = payload.text.trim();
      const userId = payload.user_id;

      if (!token) {
        const storedToken = await env.USER_TOKENS.get(`token:${userId}`);
        if (storedToken) {
          return {
            response_type: "ephemeral",
            text: "You have a Jules API token registered. Use `/jules-token <new-token>` to update it.",
          };
        }
        return {
          response_type: "ephemeral",
          text: "Usage: `/jules-token <your-jules-api-key>`\nGet your API key from https://jules.google.com/settings",
        };
      }

      await env.USER_TOKENS.put(`token:${userId}`, token);
      console.log(JSON.stringify({ message: "token registered", userId }));

      return {
        response_type: "ephemeral",
        text: "Your Jules API token has been saved securely. You can now @mention me with a task!",
      };
    });
    app.command("/jules-repo", async ({ payload }) => {
      const repo = payload.text.trim();
      const userId = payload.user_id;

      if (!repo) {
        const storedRepo = await env.USER_TOKENS.get(`repo:${userId}`);
        if (storedRepo) {
          return {
            response_type: "ephemeral",
            text: `Your Jules repository is set to \`${storedRepo}\`. Use \`/jules-repo <org/repo-name>\` to update it or \`/jules-repo clear\` to reset.`,
          };
        }
        return {
          response_type: "ephemeral",
          text: "Usage: `/jules-repo <org/repo-name>`\nExample: `/jules-repo google/jules`",
        };
      }

      if (repo.toLowerCase() === "clear") {
        await env.USER_TOKENS.delete(`repo:${userId}`);
        return {
          response_type: "ephemeral",
          text: "Your Jules repository setting has been cleared. I will now use the first available repository.",
        };
      }

      await env.USER_TOKENS.put(`repo:${userId}`, repo);
      return {
        response_type: "ephemeral",
        text: `Your Jules repository has been set to \`${repo}\`.`,
      };
    });


    app.event("app_mention", async ({ payload, context }) => {
      const userId = payload.user;
      const channel = payload.channel;
      const ts = payload.ts;
      const text = payload.text;
      const botUserId = env.SLACK_BOT_USER_ID;

      if (!userId) return;

      const userToken = await env.USER_TOKENS.get(`token:${userId}`);
      if (!userToken) {
        await context.client.chat.postEphemeral({
          channel,
          user: userId,
          text: "You need to register your Jules API token first. Use `/jules-token <your-api-key>` to get started.",
        });
        return;
      }

      const taskPrompt = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
      if (!taskPrompt) {
        await context.client.chat.postMessage({
          channel,
          thread_ts: ts,
          text: "What would you like me to help you with? Please include a task description after mentioning me.",
        });
        return;
      }

      await context.client.reactions.add({
        channel,
        timestamp: ts,
        name: "rocket",
      });

      try {
        const sources = await listJulesSources(userToken);
        if (!sources || sources.length === 0) {
          await context.client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: "No GitHub repositories found. Please connect a repository in Jules first: https://jules.google.com",
          });
          return;
        }

        const storedRepo = await env.USER_TOKENS.get(`repo:${userId}`);
        const source = selectSource(sources, storedRepo);
        const session = await createJulesSession(userToken, taskPrompt, source.name);

        await context.client.chat.postMessage({
          channel,
          thread_ts: ts,
          text: `Starting Jules session: ${session.title || taskPrompt.slice(0, 50)}\nSession ID: ${session.id}\n\nI'll update you when the task completes!`,
        });

        // Use await here since app.event's lazy handler is already wrapped in waitUntil by slack-edge
        await pollSessionAndNotify(userToken, session.id, context.client, channel, ts);
      } catch (error) {
        console.error(JSON.stringify({
          message: "failed to create jules session",
          error: error instanceof Error ? error.message : String(error),
          userId,
        }));
        await context.client.chat.postMessage({
          channel,
          thread_ts: ts,
          text: `Failed to start Jules session: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    });

    app.event("message", async ({ payload, context }) => {
      const subtype = (payload as any).subtype;
      const channel_type = (payload as any).channel_type;

      if (subtype || !channel_type || channel_type !== "im") {
        return;
      }

      const userId = (payload as any).user;
      const channel = (payload as any).channel;
      const ts = (payload as any).ts;
      const text = (payload as any).text?.trim();

      if (!text || !userId) return;

      const userToken = await env.USER_TOKENS.get(`token:${userId}`);
      if (!userToken) {
        await context.client.chat.postMessage({
          channel,
          text: "You need to register your Jules API token first. Use `/jules-token <your-api-key>` to get started.",
        });
        return;
      }

      try {
        const sources = await listJulesSources(userToken);
        if (!sources || sources.length === 0) {
          await context.client.chat.postMessage({
            channel,
            text: "No GitHub repositories found. Please connect a repository in Jules first: https://jules.google.com",
          });
          return;
        }

        const storedRepo = await env.USER_TOKENS.get(`repo:${userId}`);
        const source = selectSource(sources, storedRepo);
        const session = await createJulesSession(userToken, text, source.name);

        await context.client.chat.postMessage({
          channel,
          text: `Starting Jules session: ${session.title || text.slice(0, 50)}\nSession ID: ${session.id}`,
        });

        await pollSessionAndNotify(userToken, session.id, context.client, channel, ts);
      } catch (error) {
        console.error(JSON.stringify({
          message: "failed in dm handler",
          error: error instanceof Error ? error.message : String(error),
        }));
        await context.client.chat.postMessage({
          channel,
          text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }
    });

    return await app.run(request, ctx);
  },
} satisfies ExportedHandler<Env>;

interface JulesSource {
  name: string;
  id: string;
}

interface JulesSession {
  name: string;
  id: string;
  title?: string;
  outputs?: Array<{ pullRequest?: { url: string; title: string } }>;
}

async function listJulesSources(apiKey: string): Promise<JulesSource[]> {
  const response = await fetch(`${JULES_API_BASE}/sources`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!response.ok) {
    throw new Error(`Failed to list sources: ${response.status}`);
  }

  const data = await response.json() as { sources?: JulesSource[] };
  return data.sources || [];
}


function selectSource(sources: JulesSource[], storedRepo: string | null): JulesSource {
  if (storedRepo) {
    const match = sources.find(s =>
      s.id === storedRepo ||
      s.id === `github.com/${storedRepo}` ||
      s.name === storedRepo ||
      s.name.endsWith(`/${storedRepo}`)
    );
    if (match) return match;
  }
  return sources[0];
}

async function createJulesSession(
  apiKey: string,
  prompt: string,
  sourceName: string
): Promise<JulesSession> {
  const response = await fetch(`${JULES_API_BASE}/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      prompt,
      sourceContext: {
        source: sourceName,
        githubRepoContext: {
          startingBranch: "main",
        },
      },
      automationMode: "AUTO_CREATE_PR",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create session: ${response.status} - ${error}`);
  }

  return response.json() as Promise<JulesSession>;
}

async function getSession(apiKey: string, sessionId: string): Promise<JulesSession> {
  const response = await fetch(`${JULES_API_BASE}/sessions/${sessionId}`, {
    headers: { "x-goog-api-key": apiKey },
  });

  if (!response.ok) {
    throw new Error(`Failed to get session: ${response.status}`);
  }

  return response.json() as Promise<JulesSession>;
}

async function pollSessionAndNotify(
  apiKey: string,
  sessionId: string,
  client: any,
  channel: string,
  threadTs: string
) {
  const maxAttempts = 60;
  const pollInterval = 10000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const session = await getSession(apiKey, sessionId);

      if (session.outputs && session.outputs.length > 0) {
        const pr = session.outputs[0].pullRequest;
        if (pr) {
          await client.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: `Task completed! Pull request created: ${pr.url}`,
          } as unknown as Parameters<typeof client.chat.postMessage>[0]);
          return;
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        message: "polling error",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `Session ${sessionId} is still in progress. Check status at https://jules.google.com`,
  } as unknown as Parameters<typeof client.chat.postMessage>[0]);
}

async function pollSessionAndLog(
  apiKey: string,
  sessionId: string
) {
  const maxAttempts = 60;
  const pollInterval = 10000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const session = await getSession(apiKey, sessionId);

      if (session.outputs && session.outputs.length > 0) {
        const pr = session.outputs[0].pullRequest;
        if (pr) {
          console.log(JSON.stringify({
            message: "Notion task completed",
            sessionId,
            prUrl: pr.url
          }));
          return;
        }
      }
    } catch (error) {
      console.error(JSON.stringify({
        message: "notion polling error",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  console.log(JSON.stringify({
    message: "Notion task timed out",
    sessionId
  }));
}
