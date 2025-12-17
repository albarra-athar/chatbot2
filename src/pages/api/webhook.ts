export const prerender = false;

import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

type DFParameters = Record<string, any>;
interface DFRequestBody {
  queryResult?: {
    intent?: { displayName?: string };
    parameters?: DFParameters;
  };
}

const supabase = createClient(
  import.meta.env.SUPABASE_URL!,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ok = (text: string) =>
  new Response(JSON.stringify({ fulfillmentText: text }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

function normalizeIntent(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}
function asString(v: any, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  return String(v);
}
function sanitizeCourse(v: any): string {
  let s = asString(v, "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(/\b(mata ?kuliah|matakuliah)\b/gi, "");
  s = s.replace(/\b(tugas)(nya)?\b/gi, "");
  s = s.replace(/\b(untuk|tentang|mengenai)\b/gi, "");
  s = s.replace(/[:\-–—]/g, " ");
  s = s.replace(/[^a-z0-9\s]/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}
function parseDate(date?: string): string | null {
  if (!date) return null;
  return date.split("T")[0];
}
function parseTime(time?: string): string | null {
  if (!time) return null;
  const match = time.match(/(\d{2}:\d{2}(:\d{2})?)/);
  if (!match) return null;
  let t = match[1];
  if (t.length === 5) t += ":00";
  return t;
}
function buildDateTime(date?: string, time?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const d = parseDate(date) ?? today;
  const t = parseTime(time) ?? "23:59:00";
  return `${d} ${t}`;
}

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as DFRequestBody;

  const intentName = normalizeIntent(body.queryResult?.intent?.displayName);
  const params = body.queryResult?.parameters ?? {};
  const userId = "demo";

  try {
    // 1) ADD TASK
    if (intentName === "add_task" || intentName === "tambah_tugas" || intentName === "tambah tugas") {
      const title = asString(params.title, "").trim();
      if (!title) return ok("Judul tugasnya apa?");

      const courseRaw = asString(params.course, "Umum").trim();
      const course = sanitizeCourse(courseRaw) || "umum";

      const dueDate = asString(params.due_date, "");
      const dueTime = asString(params.due_time, "");
      const dueAt = buildDateTime(dueDate, dueTime);

      const priorityRaw = asString(params.priority, "medium").toLowerCase();
      const mapPriority: Record<string, string> = {
        rendah: "low", low: "low",
        sedang: "medium", medium: "medium",
        tinggi: "high", high: "high", urgent: "high",
      };
      const priority = mapPriority[priorityRaw] ?? "medium";

      const { error } = await supabase.from("tasks").insert({
        user_id: userId,
        title,
        course,
        due_at: dueAt,      // Supabase akan parse timestamptz
        priority,
        status: "todo",
      });

      if (error) throw error;

      return ok(`Siap! Tugas "${title}" untuk ${course} sudah disimpan dengan deadline ${dueAt}.`);
    }

    // 2) LIST TASKS BY COURSE (NOT DONE)
    if (intentName === "list_tasks_by_course" || intentName === "course" || intentName === "tugas_per_mata_kuliah") {
      const courseParam = asString(params.course, "").trim();
      if (!courseParam) return ok("Mata kuliahnya apa? Misalnya: Kalkulus, Fisika Dasar, dst.");

      const course = sanitizeCourse(courseParam) || courseParam.toLowerCase();

      const { data, error } = await supabase
        .from("tasks")
        .select("title, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", course)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) {
        return ok(`Belum ada tugas (atau semua sudah selesai) untuk mata kuliah ${courseParam}.`);
      }

      const text = data
        .map((r) => `• ${r.title} — ${String(r.due_at).replace("T", " ").slice(0, 16)} (prioritas: ${r.priority}, status: ${r.status})`)
        .join("\n");

      return ok(`Tugas ${courseParam} yang belum selesai:\n${text}`);
    }

    // 3) LIST TASKS BY DATE
    if (intentName === "list_tasks_by_date" || intentName === "tugas_per_tanggal" || intentName === "tugas_hari_ini") {
      const rawDate = (params.date ?? params.due_date) as string | undefined;
      const dateOnly = parseDate(rawDate) ?? new Date().toISOString().slice(0, 10);

      const from = `${dateOnly} 00:00:00`;
      const to = `${dateOnly} 23:59:59`;

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .gte("due_at", from)
        .lte("due_at", to)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Tidak ada tugas yang belum selesai pada tanggal ${dateOnly}.`);

      const text = data
        .map((r) => `• ${r.title} [${r.course}] — ${String(r.due_at).replace("T", " ").slice(0, 16)} (prioritas: ${r.priority})`)
        .join("\n");

      return ok(`Tugas yang belum selesai pada ${dateOnly}:\n${text}`);
    }

    // 4) UPDATE STATUS
    if (intentName === "update_status" || intentName === "ubah_status_tugas" || intentName === "ubah status tugas") {
      const titleParam = asString(params.title, "").trim();
      if (!titleParam) {
        return ok("Tolong sebutkan judul tugas yang ingin diubah statusnya, misalnya: laporan praktikum.");
      }

      const statusRaw = asString(params.status, "todo").toLowerCase();
      const mapStatus: Record<string, string> = {
        todo: "todo", "to do": "todo", belum: "todo",
        "in progress": "in_progress", progres: "in_progress", proses: "in_progress", in_progress: "in_progress",
        done: "done", selesai: "done", beres: "done",
      };
      const status = mapStatus[statusRaw] ?? "todo";

      const { data, error } = await supabase
        .from("tasks")
        .update({ status })
        .eq("user_id", userId)
        .ilike("title", titleParam) // case-insensitive match
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Tugas dengan judul "${titleParam}" tidak ditemukan di database.`);

      return ok(`Status tugas "${titleParam}" sudah diubah menjadi ${status}.`);
    }

    return ok("Webhook sudah menerima pesan, tapi intent ini belum di-handle di server.");
  } catch (err: any) {
    console.error("Webhook error:", err);
    return ok("Terjadi error di server: " + (err?.message ?? "unknown error"));
  }
};

export const GET: APIRoute = async () => {
  return new Response("OK /api/webhook", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};


