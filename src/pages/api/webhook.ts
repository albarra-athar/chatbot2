export const prerender = false;

import type { APIRoute } from "astro";
import { createClient } from "@supabase/supabase-js";

type DFParameters = Record<string, any>;
interface DFRequestBody {
  queryResult?: {
    intent?: { displayName?: string };
    parameters?: DFParameters;
    queryText?: string;
  };
}

const supabase = createClient(
  import.meta.env.SUPABASE_URL!,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY!
);

const json = (fulfillmentText: string) =>
  new Response(JSON.stringify({ fulfillmentText }), {
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
function cleanSpaces(s: string) {
  return s.replace(/\s+/g, " ").trim();
}
function titleCase(s: string) {
  const x = cleanSpaces(s);
  if (!x) return x;
  return x.charAt(0).toUpperCase() + x.slice(1);
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

// Format "YYYY-MM-DD HH:MM:SS" -> "17 Des 23:59"
function prettyDue(dueAt: string) {
  const [d, t] = dueAt.split(" ");
  const hhmm = (t ?? "23:59:00").slice(0, 5);

  const [yyyy, mm, dd] = d.split("-").map((x) => Number(x));
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const mName = monthNames[(mm ?? 1) - 1] ?? "??";

  return `${dd} ${mName} ${hhmm}`;
}

function mapPriorityText(p: string) {
  const x = (p ?? "medium").toLowerCase();
  if (x === "high") return "tinggi";
  if (x === "low") return "rendah";
  return "sedang";
}

function mapStatusText(s: string) {
  const x = (s ?? "todo").toLowerCase();
  if (x === "done") return "selesai";
  if (x === "in_progress") return "sedang dikerjakan";
  return "belum";
}

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as DFRequestBody;

  const intentName = normalizeIntent(body.queryResult?.intent?.displayName);
  const params = body.queryResult?.parameters ?? {};
  const queryText = body.queryResult?.queryText ?? "";
  const userId = "demo";

  try {
    // 1) ADD TASK
    if (intentName === "add_task" || intentName === "tambah_tugas" || intentName === "tambah tugas") {
      // kalau title kosong, coba fallback dari queryText (biar nggak nanya ulang terlalu sering)
      let title = cleanSpaces(asString(params.title, ""));
      if (!title) {
        // coba ambil setelah kata "tambah tugas" / "catat tugas"
        title = cleanSpaces(queryText.replace(/^(\s*(tambah|catat)\s+tugas)\s*/i, ""));
      }
      if (!title) return json("Oke. Judul tugasnya apa? (contoh: Quiz 2 / Laporan Praktikum)");

      const courseRaw = asString(params.course, "Umum");
      const courseKey = sanitizeCourse(courseRaw) || "umum";
      const courseDisplay = titleCase(courseKey);

      const dueDate = asString(params.due_date ?? params.date, "");
      const dueTime = asString(params.due_time ?? params.time, "");
      const dueAt = buildDateTime(dueDate, dueTime);

      const priorityRaw = asString(params.priority, "medium").toLowerCase();
      const mapPriority: Record<string, string> = {
        rendah: "low",
        low: "low",
        sedang: "medium",
        medium: "medium",
        tinggi: "high",
        high: "high",
        urgent: "high",
        penting: "high",
      };
      const priority = mapPriority[priorityRaw] ?? "medium";
      
      const { error } = await supabase.from("tasks").insert({
        user_id: userId,
        title,
        course: courseKey,
        due_at: dueAt,
        priority,
        status: "todo",
      });
      if (error) throw error;

      return json(
        `✅ Oke, aku simpan.\n• Tugas: ${title}\n• MK: ${courseDisplay}\n• Deadline: ${prettyDue(dueAt)}\n• Prioritas: ${mapPriorityText(priority)}`
      );
    }

    // 2) LIST TASKS BY COURSE (NOT DONE)
    if (intentName === "list_tasks_by_course" || intentName === "course" || intentName === "tugas_per_mata_kuliah") {
      const courseParam = cleanSpaces(asString(params.course, ""));
      if (!courseParam) return json("MK apa yang mau kamu lihat? (contoh: Kalkulus / Fisika Dasar)");

      const courseKey = sanitizeCourse(courseParam) || courseParam.toLowerCase();
      const courseDisplay = titleCase(courseKey);

      const { data, error } = await supabase
        .from("tasks")
        .select("title, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", courseKey)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return json(`Untuk ${courseDisplay}, belum ada tugas yang belum selesai.`);

      const maxShow = 8;
      const shown = data.slice(0, maxShow);
      const more = data.length - shown.length;

      const lines = shown.map(
        (r, i) =>
          `${i + 1}. ${r.title} — ${prettyDue(String(r.due_at).replace("T", " ").slice(0, 19))} • prioritas ${mapPriorityText(
            String(r.priority)
          )}`
      );

      return json(`📚 Tugas ${courseDisplay} (belum selesai):\n${lines.join("\n")}${more > 0 ? `\n…dan ${more} tugas lagi.` : ""}`);
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
      if (!data || data.length === 0) return json(`📅 Untuk tanggal ${dateOnly}, tidak ada tugas yang belum selesai.`);

      const maxShow = 8;
      const shown = data.slice(0, maxShow);
      const more = data.length - shown.length;

      const lines = shown.map((r, i) => {
        const courseDisplay = titleCase(String(r.course ?? "umum"));
        const dueAt = String(r.due_at).replace("T", " ").slice(0, 19);
        return `${i + 1}. ${r.title} (${courseDisplay}) — ${prettyDue(dueAt)} • prioritas ${mapPriorityText(String(r.priority))}`;
      });

      return json(`📅 Tugas yang jatuh tempo ${dateOnly}:\n${lines.join("\n")}${more > 0 ? `\n…dan ${more} tugas lagi.` : ""}`);
    }

    // 4) UPDATE STATUS
    if (intentName === "update_status" || intentName === "ubah_status_tugas" || intentName === "ubah status tugas") {
      const titleParam = cleanSpaces(asString(params.title, ""));
      if (!titleParam) return json("Judul tugas mana yang mau diubah? (contoh: Quiz 2)");

      const statusRaw = asString(params.status, "todo").toLowerCase();
      const mapStatus: Record<string, string> = {
        todo: "todo",
        "to do": "todo",
        belum: "todo",
        "in progress": "in_progress",
        progres: "in_progress",
        proses: "in_progress",
        dikerjakan: "in_progress",
        in_progress: "in_progress",
        done: "done",
        selesai: "done",
        beres: "done",
      };
      const status = mapStatus[statusRaw] ?? "todo";

      const { data, error } = await supabase
        .from("tasks")
        .update({ status })
        .eq("user_id", userId)
        .ilike("title", titleParam)
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) return json(`Aku nggak nemu tugas dengan judul "${titleParam}". Coba tulis judulnya persis ya.`);

      return json(`✅ Oke. Status "${titleParam}" sekarang: ${mapStatusText(status)}.`);
    }

    if (intentName === "list_all_tasks" || intentName === "list_tasks" || intentName === "tugas_apa_saja") {
  const { data, error } = await supabase
    .from("tasks")
    .select("title, course, due_at, priority, status")
    .eq("user_id", userId)
    .neq("status", "done")
    .order("due_at", { ascending: true });

  if (error) throw error;
  if (!data || data.length === 0) return json("Saat ini kamu tidak punya tugas yang belum selesai ✅");

  const lines = data.slice(0, 8).map((r, i) =>
    `${i + 1}. ${r.title} (${r.course}) — ${String(r.due_at).replace("T"," ").slice(0,16)}`
  );
  const more = data.length - Math.min(8, data.length);

  return json(`Ini tugas kamu yang belum selesai:\n${lines.join("\n")}${more > 0 ? `\n…dan ${more} lagi.` : ""}`);
}

    // Default
    return json(
      "Aku bisa bantu:\n• Tambah tugas (contoh: Tambah tugas Quiz 2 untuk Kalkulus besok)\n• Lihat tugas per MK (contoh: Tugas Kalkulus)\n• Lihat tugas per tanggal (contoh: Tugas besok)\n• Ubah status (contoh: Ubah status Quiz 2 jadi selesai)"
    );
  } catch (err: any) {
    console.error("Webhook error:", err);
    return json("Maaf, server lagi error. Coba ulang sebentar lagi ya.");
  }
};

export const GET: APIRoute = async () => {
  return new Response("OK /api/webhook", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};



