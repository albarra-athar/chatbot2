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

  // Dialogflow Messenger payload (kalau lewat widget)
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
 * DF @sys.date-time bisa muncul sebagai:
 * - "2025-12-20T10:00:00+07:00"
 * - { startDateTime, endDateTime }
 * - { startDate, endDate } (date only / range)
 * - "2025-12-20" (date only)
 */
function isoFromDateOnly(
  dateStr?: string,
  defaultTime = "23:59:00"
): string | null {
  if (!dateStr) return null;
  const d = dateStr.split("T")[0].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${d}T${defaultTime}+07:00`;
}

function extractISODateTime(v: any): string | null {
  const x = pickFirst(v);
  if (!x) return null;

  if (typeof x === "string") {
    // bisa ISO atau YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(x.trim())) {
      return isoFromDateOnly(x.trim(), "23:59:00");
    }
    return x;
  }

  if (typeof x === "object") {
    const iso =
      x.startDateTime ??
      x.date_time ??
      x.dateTime ??
      x.startDate ?? // kadang date only
      x.date ?? // kadang date only
      null;

    if (typeof iso === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso.trim())) {
        return isoFromDateOnly(iso.trim(), "23:59:00");
      }
      return iso;
    }
  }

  return null;
}

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

function extractPriorityFromText(text: string): "low" | "medium" | "high" | "" {
  const s = (text ?? "").toLowerCase();
  if (/\b(tinggi|urgent|penting)\b/.test(s)) return "high";
  if (/\b(rendah)\b/.test(s)) return "low";
  if (/\b(sedang|normal)\b/.test(s)) return "medium";
  return "";
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

/** Ambil teks asli user dari beberapa tempat */
function getUserText(body: DFRequestBody): string {
  const q = body.queryResult?.queryText;
  if (q) return q;

  const t =
    body.originalDetectIntentRequest?.payload?.data?.message?.text ??
    body.originalDetectIntentRequest?.payload?.data?.text ??
    "";
  return typeof t === "string" ? t : "";
}

/**
 * Ekstrak judul tugas dari kalimat seperti:
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

/** Ambil title dari parameter (kalau user set param lain selain "title") */
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

function pickStatusFromText(text: string): string {
  const s = (text ?? "").toLowerCase();
  // urutan penting: cek done dulu
  if (/\b(selesai|done|beres|kelar)\b/.test(s)) return "done";
  if (/\b(in\s*progress|progres|proses|dikerjakan)\b/.test(s)) return "in_progress";
  if (/\b(todo|belum)\b/.test(s)) return "todo";
  return "";
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
    if (
      intentName === "add_task" ||
      intentName === "tambah_tugas" ||
      intentName === "tambah tugas"
    ) {
      const userText = getUserText(body);

      const title = asString(params.title, "").trim();
      if (!title) return ok("Judul tugasnya apa?");

      const courseRaw = asString(params.course, "Umum").trim();
      const course = sanitizeCourse(courseRaw) || "umum";

      // priority: dari param, kalau kosong ambil dari teks
      const prFromParam = asString(params.priority ?? params.prioritas, "").trim();
      const prFromText = extractPriorityFromText(userText);
      const priority = mapPriority(prFromParam || prFromText || "medium");

      // date-time: ambil dari beberapa nama param
      const dfDateTimeRaw =
        params["date-time"] ?? params["date_time"] ?? params["dateTime"] ?? params["datetime"];

      let dueISO = extractISODateTime(dfDateTimeRaw);

      // fallback: kalau ada date-only param
      if (!dueISO) {
        const dateOnly = asString(params.date ?? params.due_date ?? params["due-date"], "");
        dueISO = isoFromDateOnly(dateOnly, "23:59:00");
      }

      // fallback terakhir: hari ini 23:59
      if (!dueISO) {
        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Jakarta",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        dueISO = isoFromDateOnly(today, "23:59:00")!;
      }

      const { error } = await supabase.from("tasks").insert({
        user_id: userId,
        title,
        course,
        due_at: dueISO,
        priority,
        status: "todo",
      });

      if (error) throw error;

      return ok(
        `✅ Oke, sudah aku simpan.\n• Tugas: ${title}\n• MK: ${courseRaw || course}\n• Deadline: ${formatForUser(
          dueISO
        )}\n• Prioritas: ${priority}`
      );
    }

    // =======================
    // 2) LIST TASKS BY COURSE
    // =======================
    if (
      intentName === "list_tasks_by_course" ||
      intentName === "course" ||
      intentName === "tugas_per_mata_kuliah"
    ) {
      const courseParam = asString(params.course, "").trim();
      if (!courseParam)
        return ok("Mata kuliahnya apa? Contoh: Kalkulus, Fisika Dasar, dst.");

      const course = sanitizeCourse(courseParam) || courseParam.toLowerCase();

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", course)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;

      if (!data || data.length === 0) {
        return ok(`Belum ada tugas (atau semua sudah selesai) untuk ${courseParam}.`);
      }

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
    if (
      intentName === "list_tasks_by_date" ||
      intentName === "tugas_per_tanggal" ||
      intentName === "tugas_hari_ini"
    ) {
      const dfDateTimeRaw =
        params["date-time"] ?? params["date_time"] ?? params["dateTime"] ?? params["datetime"];

      let iso = extractISODateTime(dfDateTimeRaw);

      if (!iso) {
        const dateOnly = asString(params.date ?? params.due_date ?? params["due-date"], "");
        iso = isoFromDateOnly(dateOnly, "23:59:00");
      }

      if (!iso) {
        const today = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Jakarta",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date());
        iso = isoFromDateOnly(today, "23:59:00")!;
      }

      const dt = new Date(iso);
      const dayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dt);

      const from = `${dayStr}T00:00:00+07:00`;
      const to = `${dayStr}T23:59:59+07:00`;

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .gte("due_at", from)
        .lte("due_at", to)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;

      if (!data || data.length === 0) {
        return ok(`Tidak ada tugas yang belum selesai pada ${dayStr}.`);
      }

      const text = data
        .map((r) => {
          const due = r.due_at ? formatForUser(String(r.due_at)) : "-";
          return `• ${r.title} [${r.course}] — ${due} (prio: ${r.priority})`;
        })
        .join("\n");

      return ok(`📅 Tugas yang belum selesai pada ${dayStr}:\n${text}`);
    }

    // =======================
    // 4) UPDATE STATUS
    // - done/selesai => hapus task dari DB
    // - lainnya => update status
    // =======================
    if (
      intentName === "update_status" ||
      intentName === "ubah_status_tugas" ||
      intentName === "ubah status tugas"
    ) {
      const userText = getUserText(body);

      // status: dari param kalau ada, kalau tidak ambil dari teks
      const statusFromParam = asString(params.status, "").trim();
      const statusFromText = pickStatusFromText(userText);
      const status = mapStatus(statusFromParam || statusFromText || "done");

      // title: dari params atau dari text
      let title = pickTitleFromParams(params);
      if (!title) title = extractTitleFromText(userText);

      if (!title) {
        return ok(
          'Judul tugasnya apa yang mau diubah statusnya?\nContoh: "Tandai tugas Quiz 1 selesai"'
        );
      }

      // cari task yang paling relevan (match sebagian judul)
      const pattern = `%${title}%`;

      const { data: found, error: findErr } = await supabase
        .from("tasks")
        .select("id, title, status")
        .eq("user_id", userId)
        .ilike("title", pattern)
        .order("due_at", { ascending: true })
        .limit(1);

      if (findErr) throw findErr;

      if (!found || found.length === 0) {
        return ok(`Aku tidak menemukan tugas yang cocok dengan "${title}". Coba tulis judulnya lebih spesifik.`);
      }

      const task = found[0];

      // kalau done => hapus (biar hilang dari list)
      if (status === "done") {
        const { error: delErr } = await supabase
          .from("tasks")
          .delete()
          .eq("id", task.id)
          .eq("user_id", userId);

        if (delErr) throw delErr;

        return ok(`✅ Sip. Tugas "${task.title}" sudah ditandai selesai dan dihapus dari daftar.`);
      }

      // selain done => update status
      const { error: updErr } = await supabase
        .from("tasks")
        .update({ status })
        .eq("id", task.id)
        .eq("user_id", userId);

      if (updErr) throw updErr;

      return ok(`✅ Oke. Status "${task.title}" sekarang: ${status}.`);
    }

    return ok("Webhook aktif, tapi intent ini belum di-handle.");
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











