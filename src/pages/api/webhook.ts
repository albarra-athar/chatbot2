// src/pages/api/webhook.ts
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

  // DF Messenger payload (kadang ada di sini)
  originalDetectIntentRequest?: {
    payload?: any;
  };
}

const supabase = createClient(
  import.meta.env.SUPABASE_URL!,
  import.meta.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ok = (text: string) =>
  new Response(JSON.stringify({ fulfillmentText: text }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

function normalizeIntent(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

function asString(v: any, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v === "string") return v;
  return String(v);
}

function pickFirst(v: any) {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Dialogflow @sys.date-time bisa bentuk:
 * - string ISO: "2025-12-20T10:00:00+07:00"
 * - object: { startDateTime, endDateTime } (range)
 * - array dari object/string
 */
function extractISODateTime(v: any): string | null {
  const x = pickFirst(v);
  if (!x) return null;

  if (typeof x === "string") return x;

  if (typeof x === "object") {
    // range biasanya startDateTime
    const cand =
      x.startDateTime ?? x.date_time ?? x.dateTime ?? x.start ?? x.value ?? null;
    if (typeof cand === "string") return cand;
  }

  return null;
}

/**
 * Kalau cuma dapat tanggal (YYYY-MM-DD) -> bikin ISO default jam 23:59 WIB
 */
function isoFromDateOnly(dateStr?: string, defaultTime = "23:59:00"): string | null {
  if (!dateStr) return null;
  const d = dateStr.split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${d}T${defaultTime}+07:00`;
}

/**
 * Format ISO untuk user (WIB)
 */
function formatForUser(iso: string): string {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso;

  const fmtDate = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(dt);

  const fmtTime = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(dt);

  return `${fmtDate}, ${fmtTime} WIB`;
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

function mapPriority(raw: string): "low" | "medium" | "high" {
  const p = raw.trim().toLowerCase();
  const map: Record<string, "low" | "medium" | "high"> = {
    rendah: "low",
    low: "low",
    sedang: "medium",
    medium: "medium",
    normal: "medium",
    tinggi: "high",
    high: "high",
    urgent: "high",
    penting: "high",
  };
  return map[p] ?? "medium";
}

function mapStatus(raw: string): "todo" | "in_progress" | "done" {
  const s = raw.trim().toLowerCase();
  const map: Record<string, "todo" | "in_progress" | "done"> = {
    todo: "todo",
    "to do": "todo",
    belum: "todo",

    "in progress": "in_progress",
    inprogress: "in_progress",
    progres: "in_progress",
    proses: "in_progress",
    dikerjakan: "in_progress",
    in_progress: "in_progress",

    done: "done",
    selesai: "done",
    beres: "done",
    kelar: "done",
  };
  return map[s] ?? "todo";
}

/** Ambil teks asli user dari berbagai tempat */
function getUserText(body: DFRequestBody): string {
  const q = body.queryResult?.queryText;
  if (q) return q;

  const t =
    body.originalDetectIntentRequest?.payload?.data?.message?.text ??
    body.originalDetectIntentRequest?.payload?.data?.text ??
    "";
  return typeof t === "string" ? t : "";
}

/** Ambil title dari params (kalau ada) */
function pickTitleFromParams(params: DFParameters): string {
  const candidates = [
    params.title,
    params.task,
    params.tugas,
    params.task_title,
    params.any,
    params["task-name"],
    params["task_name"],
  ];

  for (const c of candidates) {
    const v = asString(pickFirst(c), "").trim();
    if (v) return v;
  }
  return "";
}

/**
 * Ekstrak judul tugas dari kalimat:
 * - "Tandai tugas Quiz 1 selesai"
 * - "Ubah status tugas Laporan Praktikum jadi in progress"
 */
function extractTitleFromText(text: string): string {
  const s = (text ?? "").trim();

  const patterns: RegExp[] = [
    /tandai\s+tugas\s+(.+?)\s+(selesai|done)\b/i,
    /ubah\s+status\s+tugas\s+(.+?)\s+jadi\s+(.+)\b/i,
    /status\s+tugas\s+(.+?)\s+(selesai|done|todo|in progress|in_progress)\b/i,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }

  const m2 = s.match(/\btugas\b\s+(.+)/i);
  if (m2 && m2[1]) return m2[1].trim();

  return "";
}

/** Ambil ISO day string "YYYY-MM-DD" berdasarkan WIB */
function todayWIB_YYYY_MM_DD(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as DFRequestBody;

  const intentName = normalizeIntent(body.queryResult?.intent?.displayName);
  const params = body.queryResult?.parameters ?? {};
  const userId = "demo";

  try {
    // =======================
    // 1) ADD TASK
    // =======================
    if (intentName === "add_task" || intentName === "tambah_tugas" || intentName === "tambah tugas") {
      const title = asString(params.title, "").trim();
      if (!title) return ok("Judul tugasnya apa?");

      const courseRaw = asString(params.course, "Umum").trim();
      const course = sanitizeCourse(courseRaw) || "umum";

      const priority = mapPriority(asString(params.priority, "medium"));

      // kamu pakai param "date-time" di Dialogflow
      const dfDateTimeRaw = params["date-time"] ?? params["date_time"] ?? params["dateTime"];
      let dueISO = extractISODateTime(dfDateTimeRaw);

      // fallback kalau cuma dapat tanggal
      if (!dueISO) {
        const dateOnly = asString(params.date ?? params.due_date, "");
        dueISO = isoFromDateOnly(dateOnly);
      }

      // fallback terakhir: hari ini 23:59
      if (!dueISO) {
        dueISO = isoFromDateOnly(todayWIB_YYYY_MM_DD(), "23:59:00")!;
      }

      const { error } = await supabase.from("public.tasks").insert({
        user_id: userId,
        title,
        course,
        due_at: dueISO,
        priority,
        status: "todo",
      });

      if (error) throw error;

      return ok(
        `✅ Oke, sudah aku simpan.\n` +
          `• Tugas: ${title}\n` +
          `• MK: ${courseRaw || course}\n` +
          `• Deadline: ${formatForUser(dueISO)}\n` +
          `• Prioritas: ${priority}`
      );
    }

    // =======================
    // 2) LIST TASKS BY COURSE
    // =======================
    if (intentName === "list_tasks_by_course" || intentName === "course" || intentName === "tugas_per_mata_kuliah") {
      const courseParam = asString(params.course, "").trim();
      if (!courseParam) return ok("Mata kuliahnya apa? Contoh: Kalkulus, Fisika Dasar, dst.");

      const course = sanitizeCourse(courseParam) || courseParam.toLowerCase();

      const { data, error } = await supabase
        .from("public.tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", course)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Belum ada tugas (atau semua sudah selesai) untuk ${courseParam}.`);

      const text = data
        .map((r) => {
          const due = r.due_at ? formatForUser(String(r.due_at)) : "-";
          return `• ${r.title} — ${due} (prio: ${r.priority}, status: ${r.status})`;
        })
        .join("\n");

      return ok(`📚 Tugas ${courseParam} yang belum selesai:\n${text}`);
    }

    // =======================
    // 3) LIST TASKS BY DATE
    // =======================
    if (intentName === "list_tasks_by_date" || intentName === "tugas_per_tanggal" || intentName === "tugas_hari_ini") {
      const dfDateTimeRaw = params["date-time"] ?? params["date_time"] ?? params["dateTime"];
      let iso = extractISODateTime(dfDateTimeRaw);

      if (!iso) {
        const dateOnly = asString(params.date ?? params.due_date, "");
        iso = isoFromDateOnly(dateOnly);
      }

      if (!iso) iso = isoFromDateOnly(todayWIB_YYYY_MM_DD())!;

      // ambil day berdasarkan WIB
      const dayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso));

      const from = `${dayStr}T00:00:00+07:00`;
      const to = `${dayStr}T23:59:59+07:00`;

      const { data, error } = await supabase
        .from("public.tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .gte("due_at", from)
        .lte("due_at", to)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Tidak ada tugas yang belum selesai pada ${dayStr}.`);

      const text = data
        .map((r) => {
          const due = r.due_at ? formatForUser(String(r.due_at)) : "-";
          return `• ${r.title} [${r.course}] — ${due} (prio: ${r.priority})`;
        })
        .join("\n");

      return ok(`📅 Tugas yang belum selesai pada ${dayStr}:\n${text}`);
    }

    // =======================
    // 4) UPDATE STATUS (fix)
    // =======================
    if (intentName === "update_status" || intentName === "ubah_status_tugas" || intentName === "ubah status tugas") {
      const status = mapStatus(asString(params.status, "done"));

      let title = pickTitleFromParams(params);
      if (!title) {
        const userText = getUserText(body);
        title = extractTitleFromText(userText);
      }

      if (!title) {
        return ok("Judul tugasnya apa yang mau diubah statusnya?\nContoh: Tandai tugas Quiz 1 selesai");
      }

      // match sebagian judul (lebih toleran)
      const pattern = `%${title}%`;

      const { data, error } = await supabase
        .from("public.tasks")
        .update({ status })
        .eq("user_id", userId)
        .ilike("title", pattern)
        .select("id, title, status")
        .limit(1);

      if (error) throw error;
      if (!data || data.length === 0) {
        return ok(`Aku tidak menemukan tugas yang cocok dengan "${title}". Coba tulis judulnya lebih spesifik.`);
      }

      return ok(`✅ Oke. Status "${data[0].title}" sudah jadi ${data[0].status}.`);
    }

    // =======================
    // Default
    // =======================
    return ok("Webhook aktif, tapi intent ini belum di-handle.");
  } catch (err: any) {
    console.error("Webhook error:", err);
    // tampilkan error asli biar kamu gampang debug
    return ok("Terjadi error di server: " + (err?.message ?? "unknown error"));
  }
};

export const GET: APIRoute = async () => {
  return new Response("OK /api/webhook", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};









