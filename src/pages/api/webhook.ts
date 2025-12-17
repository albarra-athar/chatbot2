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

const ok = (text: string) =>
  new Response(JSON.stringify({ fulfillmentText: text }), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

function normalizeIntent(name?: string | null) {
  return (name ?? "").trim().toLowerCase();
}

function asString(v: any, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return v.length ? String(v[0]) : fallback;
  return String(v);
}

function sanitizeCourse(v: any): string {
  let s = asString(v, "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(/\b(mata ?kuliah|matakuliah|mk)\b/gi, "");
  s = s.replace(/[:\-–—]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function parsePriorityFromText(text: string): "low" | "medium" | "high" {
  const t = (text ?? "").toLowerCase();
  if (/\b(urgent|tinggi|high|penting)\b/.test(t)) return "high";
  if (/\b(rendah|low)\b/.test(t)) return "low";
  if (/\b(sedang|medium|normal|biasa)\b/.test(t)) return "medium";
  return "medium";
}

function priorityLabel(p: "low" | "medium" | "high") {
  if (p === "high") return "tinggi";
  if (p === "low") return "rendah";
  return "sedang";
}

/** @sys.date bisa "2025-01-20" atau "2025-01-20T00:00:00+07:00" */
function pickDateOnly(sysDate?: string) {
  if (!sysDate) return null;
  return sysDate.split("T")[0]; // YYYY-MM-DD
}

/** @sys.time bisa "19:00:00" atau "2025-...T19:00:00+07:00" (kadang) */
function pickTimeOnly(sysTime?: string) {
  if (!sysTime) return null;

  // kalau sudah HH:MM atau HH:MM:SS
  const m1 = sysTime.match(/\b(\d{2}:\d{2})(:\d{2})?\b/);
  if (m1) return m1[1] + ":00"; // jadi HH:MM:SS

  // kalau ISO, ambil bagian jam
  const m2 = sysTime.match(/T(\d{2}:\d{2})(:\d{2})?/);
  if (m2) return m2[1] + ":00";

  return null;
}

/** Gabungkan date + time menjadi ISO WIB */
function buildDueIso(dateOnly: string, timeOnly: string) {
  // hasil: YYYY-MM-DDTHH:MM:SS+07:00
  return `${dateOnly}T${timeOnly}+07:00`;
}

/** fallback: end of day WIB */
function endOfDayIso(dateOnly: string) {
  return `${dateOnly}T23:59:00+07:00`;
}

function todayDateOnlyWIB() {
  const now = new Date();
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(now);
  return ymd; // YYYY-MM-DD
}

function formatWIB(iso: string) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(d).replace(".", "") + " WIB";
}

function extractTitle(params: DFParameters, queryText: string) {
  let title = asString(params.title ?? params.task_title ?? params.judul, "").trim();

  // kalau title kepotong / kosong, coba ambil dari queryText
  if (!title || /^untuk$/i.test(title) || /^tugas$/i.test(title)) {
    const t = queryText ?? "";
    const m = t.match(/(?:tambah|buat|catat)\s+tugas\s+(.+?)\s+untuk\s+/i);
    if (m?.[1]) title = m[1].trim();
  }
  return title;
}

function extractCourse(params: DFParameters, queryText: string) {
  let course = sanitizeCourse(params.course ?? params.mk ?? params.mata_kuliah);
  if (!course) {
    const m = (queryText ?? "").match(/\buntuk\s+([a-z0-9 ]{2,30})\b/i);
    if (m?.[1]) course = sanitizeCourse(m[1]);
  }
  return course || "umum";
}

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as DFRequestBody;

  const intentName = normalizeIntent(body.queryResult?.intent?.displayName);
  const params = body.queryResult?.parameters ?? {};
  const queryText = body.queryResult?.queryText ?? "";

  const userId = "demo";

  try {
    // ============ add_task ============
    if (intentName === "add_task") {
      const title = extractTitle(params, queryText);
      if (!title) return ok("Judul tugasnya apa? (contoh: “Quiz 2”, “Laporan Praktikum”)");

      const course = extractCourse(params, queryText);

      // Ambil due_date & due_time (cara paling stabil)
      const dueDate = pickDateOnly(asString(params.due_date, ""));
      const dueTime = pickTimeOnly(asString(params.due_time, ""));

      // Fallback: kalau user pakai date-time
      const dateTime = asString(params["date-time"] ?? params.date_time ?? params.datetime, "");

      let dueIso: string;

      if (dueDate && dueTime) {
        dueIso = buildDueIso(dueDate, dueTime);
      } else if (dueDate && !dueTime) {
        dueIso = endOfDayIso(dueDate);
      } else if (!dueDate && dueTime) {
        // ada jam tapi gak ada tanggal -> pakai hari ini
        dueIso = buildDueIso(todayDateOnlyWIB(), dueTime);
      } else if (dateTime && dateTime.includes("T")) {
        // date-time dari DF
        dueIso = dateTime;
      } else {
        // terakhir: hari ini 23:59
        dueIso = endOfDayIso(todayDateOnlyWIB());
      }

      const priority = parsePriorityFromText(queryText);

      const { error } = await supabase.from("tasks").insert({
        user_id: userId,
        title: title.trim(),
        course,
        due_at: dueIso,
        priority,
        status: "todo",
      });

      if (error) throw error;

      const reply =
        `✅ Oke, sudah aku simpan.\n` +
        `• Tugas: ${title.trim()}\n` +
        `• MK: ${course}\n` +
        `• Deadline: ${formatWIB(dueIso)}\n` +
        `• Prioritas: ${priorityLabel(priority)}`;

      return ok(reply);
    }

    // ============ list_tasks_by_course ============
    if (intentName === "list_tasks_by_course") {
      const course = extractCourse(params, queryText);
      const statusRaw = asString(params.status, "").toLowerCase();

      const mapStatus: Record<string, "todo" | "in_progress" | "done" | ""> = {
        todo: "todo", "to do": "todo", belum: "todo",
        "in progress": "in_progress", progres: "in_progress", proses: "in_progress", in_progress: "in_progress",
        done: "done", selesai: "done", beres: "done",
        "": "",
      };

      const status = mapStatus[statusRaw] ?? "";

      let q = supabase
        .from("tasks")
        .select("title, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", course);

      if (status) q = q.eq("status", status);
      else q = q.neq("status", "done");

      const { data, error } = await q.order("due_at", { ascending: true });
      if (error) throw error;

      if (!data || data.length === 0) {
        return ok(`Tidak ada tugas untuk ${course}${status ? ` (status: ${status})` : ""}.`);
      }

      const lines = data.slice(0, 10).map((r) =>
        `• ${r.title} — ${formatWIB(String(r.due_at))} (${priorityLabel(r.priority)}, ${r.status})`
      );

      const more = data.length > 10 ? `\n…dan ${data.length - 10} lainnya.` : "";
      return ok(`📚 Tugas untuk ${course}:\n${lines.join("\n")}${more}`);
    }

    // ============ list_tasks_by_date ============
    if (intentName === "list_tasks_by_date") {
      const dateTime = asString(params["date-time"] ?? params.date_time ?? params.datetime, "");
      if (!dateTime) return ok("Tanggalnya kapan? (contoh: “hari ini”, “besok”, atau “tanggal 20 November”)");

      // ambil date WIB dari dateTime
      const dt = new Date(dateTime);
      const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(dt);
      const from = `${ymd}T00:00:00+07:00`;
      const to = `${ymd}T23:59:59+07:00`;

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .gte("due_at", from)
        .lte("due_at", to)
        .neq("status", "done")
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Tidak ada tugas (yang belum selesai) pada ${ymd}.`);

      const lines = data.slice(0, 10).map((r) =>
        `• ${r.title} [${r.course}] — ${formatWIB(String(r.due_at))} (${priorityLabel(r.priority)})`
      );

      const more = data.length > 10 ? `\n…dan ${data.length - 10} lainnya.` : "";
      return ok(`🗓️ Tugas pada ${ymd}:\n${lines.join("\n")}${more}`);
    }

    // ============ update_status ============
    if (intentName === "update_status") {
      const statusRaw = asString(params.status, "").toLowerCase();
      const mapStatus: Record<string, "todo" | "in_progress" | "done"> = {
        todo: "todo", "to do": "todo", belum: "todo",
        "in progress": "in_progress", progres: "in_progress", proses: "in_progress", in_progress: "in_progress",
        done: "done", selesai: "done", beres: "done",
      };

      const status = mapStatus[statusRaw];
      if (!status) return ok("Statusnya mau jadi apa? (todo / in progress / selesai)");

      const m =
        queryText.match(/tugas\s+(.+?)\s+(?:jadi|ke)\s+/i) ||
        queryText.match(/tandai\s+tugas\s+(.+?)\s+(?:jadi|sebagai)?\s*/i);

      const titleParam = (m?.[1] ?? "").trim();
      if (!titleParam) return ok("Judul tugasnya apa yang mau diubah statusnya?");

      const { data, error } = await supabase
        .from("tasks")
        .update({ status })
        .eq("user_id", userId)
        .ilike("title", titleParam)
        .select("id");

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Aku tidak nemu tugas dengan judul "${titleParam}".`);

      return ok(`✅ Sip. Status "${titleParam}" sudah aku ubah jadi ${status}.`);
    }

    return ok("Webhook aktif ✅ Tapi intent ini belum aku handle di server.");
  } catch (err: any) {
    console.error("Webhook error:", err?.message ?? err);
    return ok("Maaf, ada error di server. Coba ulangi lagi ya.");
  }
};

export const GET: APIRoute = async () => {
  return new Response("OK /api/webhook", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
};





