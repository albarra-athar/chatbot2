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
  originalDetectIntentRequest?: { payload?: any };
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

// ====== DATE-TIME helper (param kamu: date-time @sys.date-time) ======
function extractISODateTime(v: any): string | null {
  const x = pickFirst(v);
  if (!x) return null;
  if (typeof x === "string") return x;
  if (typeof x === "object") {
    const cand = x.startDateTime ?? x.dateTime ?? x.start ?? x.value ?? null;
    if (typeof cand === "string") return cand;
  }
  return null;
}

function todayWIB_YYYY_MM_DD(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isoFromDateOnly(dateStr?: string, defaultTime = "23:59:00"): string | null {
  if (!dateStr) return null;
  const d = dateStr.split("T")[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  return `${d}T${defaultTime}+07:00`;
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

// ===== title extraction for update_status =====
function getUserText(body: DFRequestBody): string {
  return (
    body.queryResult?.queryText ??
    body.originalDetectIntentRequest?.payload?.data?.message?.text ??
    ""
  );
}

function pickTitleFromParams(params: DFParameters): string {
  const candidates = [params.title, params.task_title, params.task, params.tugas];
  for (const c of candidates) {
    const v = asString(pickFirst(c), "").trim();
    if (v) return v;
  }
  return "";
}

function extractTitleFromText(text: string): string {
  const s = (text ?? "").trim();

  const patterns: RegExp[] = [
    /tandai\s+tugas\s+(.+?)\s+(selesai|done)\b/i,
    /ubah\s+status\s+tugas\s+(.+?)\s+jadi\s+(.+)\b/i,
    /tugas\s+(.+?)\s+(selesai|done)\b/i,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1]) return m[1].trim();
  }

  const m2 = s.match(/\btugas\b\s+(.+)/i);
  if (m2 && m2[1]) return m2[1].trim();

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
    if (intentName === "add_task") {
      const title = asString(params.title, "").trim();
      if (!title) return ok("Judul tugasnya apa?");

      const courseRaw = asString(params.course, "Umum").trim();
      const course = sanitizeCourse(courseRaw) || "umum";

      const priority = mapPriority(asString(params.priority, "medium"));

      const dfDateTimeRaw = params["date-time"] ?? params["date_time"] ?? params["dateTime"];
      let dueISO = extractISODateTime(dfDateTimeRaw);

      if (!dueISO) {
        const dateOnly = asString(params.date ?? params.due_date, "");
        dueISO = isoFromDateOnly(dateOnly);
      }
      if (!dueISO) {
        dueISO = isoFromDateOnly(todayWIB_YYYY_MM_DD(), "23:59:00")!;
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
    if (intentName === "list_tasks_by_course") {
      const courseParam = asString(params.course, "").trim();
      if (!courseParam) return ok("Mata kuliahnya apa? Contoh: Kalkulus, Fisika Dasar.");

      const course = sanitizeCourse(courseParam) || courseParam.toLowerCase();

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .ilike("course", course)
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Belum ada tugas untuk ${courseParam}.`);

      const text = data
        .map((r) => `• ${r.title} — ${formatForUser(String(r.due_at))} (prio: ${r.priority}, status: ${r.status})`)
        .join("\n");

      return ok(`📚 Daftar tugas ${courseParam}:\n${text}`);
    }

    // =======================
    // 3) LIST TASKS BY DATE (pakai rentang 1 hari WIB)
    // =======================
    if (intentName === "list_tasks_by_date") {
      const dfDateTimeRaw = params["date-time"] ?? params["date_time"] ?? params["dateTime"];
      let iso = extractISODateTime(dfDateTimeRaw);

      if (!iso) {
        const dateOnly = asString(params.date ?? params.due_date, "");
        iso = isoFromDateOnly(dateOnly);
      }
      if (!iso) iso = isoFromDateOnly(todayWIB_YYYY_MM_DD())!;

      const dayStr = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Jakarta",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso));

      const from = `${dayStr}T00:00:00+07:00`;
      const to = `${dayStr}T23:59:59+07:00`;

      const { data, error } = await supabase
        .from("tasks")
        .select("title, course, due_at, priority, status")
        .eq("user_id", userId)
        .gte("due_at", from)
        .lte("due_at", to)
        .order("due_at", { ascending: true });

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Tidak ada tugas pada ${dayStr}.`);

      const text = data
        .map((r) => `• ${r.title} [${r.course}] — ${formatForUser(String(r.due_at))} (prio: ${r.priority}, status: ${r.status})`)
        .join("\n");

      return ok(`📅 Tugas pada ${dayStr}:\n${text}`);
    }

    // =======================
    // 4) UPDATE STATUS
    // - kalau DONE/SELESAI -> HAPUS dari DB
    // =======================
    if (intentName === "update_status") {
      const status = mapStatus(asString(params.status, "done"));

      let title = pickTitleFromParams(params);
      if (!title) title = extractTitleFromText(getUserText(body));

      if (!title) return ok("Judul tugasnya apa?\nContoh: Tandai tugas Quiz 1 selesai");

      const pattern = `%${title}%`;

      if (status === "done") {
        const { data, error } = await supabase
          .from("tasks")
          .delete()
          .eq("user_id", userId)
          .ilike("title", pattern)
          .select("title")
          .limit(1);

        if (error) throw error;
        if (!data || data.length === 0) return ok(`Aku tidak menemukan tugas yang cocok dengan "${title}".`);

        return ok(`🗑️ Oke. Tugas "${data[0].title}" sudah ditandai selesai dan dihapus dari database.`);
      }

      // status selain done -> update
      const { data, error } = await supabase
        .from("tasks")
        .update({ status })
        .eq("user_id", userId)
        .ilike("title", pattern)
        .select("title, status")
        .limit(1);

      if (error) throw error;
      if (!data || data.length === 0) return ok(`Aku tidak menemukan tugas yang cocok dengan "${title}".`);

      return ok(`✅ Oke. Status "${data[0].title}" sekarang ${data[0].status}.`);
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










