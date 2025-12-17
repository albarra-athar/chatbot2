// src/pages/api/webhook.ts
import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

type DialogflowWebhookRequest = {
  responseId?: string;
  queryResult?: {
    intent?: { displayName?: string };
    parameters?: Record<string, any>;
    queryText?: string;
  };
};

const supabase = createClient(
  import.meta.env.SUPABASE_URL!,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = (await request.json()) as DialogflowWebhookRequest;

    const intent = body.queryResult?.intent?.displayName ?? "UnknownIntent";
    const params = body.queryResult?.parameters ?? {};
    const text = body.queryResult?.queryText ?? "";

    // Contoh: intent "task.add" dengan parameter task_title
    if (intent === "task.add") {
      const title =
        params.task_title ??
        params.title ??
        text;

      if (!title || String(title).trim().length === 0) {
        return new Response(
          JSON.stringify({
            fulfillmentText: "Judul tugasnya apa?",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const { error } = await supabase.from("tasks").insert({
        title: String(title).trim(),
        status: "todo",
      });

      if (error) throw error;

      return new Response(
        JSON.stringify({
          fulfillmentText: `Oke, tugas "${String(title).trim()}" sudah aku simpan.`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // Default response untuk intent lain
    return new Response(
      JSON.stringify({
        fulfillmentText: "Webhook aktif. Intent belum di-handle.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    // Log error singkat (Vercel logs nanti kepake)
    console.error("Webhook error:", err?.message ?? err);

    return new Response(
      JSON.stringify({
        fulfillmentText: "Maaf, ada error di server.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }
};

// Optional: health check GET biar gampang cek browser
export const GET: APIRoute = async () => {
  return new Response("OK /api/webhook", { status: 200 });
};
