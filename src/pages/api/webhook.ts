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

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

const ok = (text: string) => json({ fulfillmentText: text });

function normalizeIntent(name?: string | null): string {
  return (name ?? "").trim().toLowerCase();
}

function asString(v: any, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(v)) return v.length ? String(v[0]) : fallback;
  return String(v);
}

/** Karena di Dialogflow kamu beberapa param IS LIST, ambil item pertama yang masuk akal */
function firstOf<T>(v: any): T | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return (v[0] as T) ?? null;
  return v as T;
}

function sanitizeCourse(v: any): string {
  let s = asString(v, "").toLowerCase().trim();
  if (!s) return "";
  s = s.replace(/\b(mata ?kuliah|matakuliah|mk)\b/gi, "");
  s = s.replace(/[:\-–—]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Parse prioritas dari text kalau DF belum ngasih parameter */
function parsePriorityFromText(text: string): "low" | "medium" | "high" {
  const t = (text ?? "").toLowerCase();

  // tangkap: "prioritas tinggi", "priority high", "urgent"
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

/**
 * Dialogflow @sys.date-time kadang bentuknya:
 * - "2025-01-20T12:00:00+07:00"
 * - array ["..."]
 * - object { startDateTime, endDateTime } (range)
 * - object { date_time: "..."} (kadang)
 */
function extractDateTime(params: DFParameters, queryText: string) {
  const raw = params["date-time"] ?? params["date_time"] ?? params["datetime"] ?? params["dateTime"];

  // 1) string / array
  const rawStr = asString(raw, "");
  if (rawStr && typeof rawStr === "string" && rawStr.includes("T")) {
    return { iso: rawStr, range: null as null | { start: string; end: string } };
  }

  // 2) object range: { startDateTime, endDateTime }
  const rawObj = firstOf<any>(raw);
  if (rawObj && typeof rawObj === "object") {
    const start = rawObj.startDateTime || rawObj.start_date_time || rawObj.start;
    const end = rawObj.endDateTime || rawObj.end_date_time || rawObj.end;
    const single = rawObj.date_time || rawObj.dateTime || rawObj.value;

    if (typeof single === "string" && single.includes("T")) {
      return { iso: single, range: null };
    }
    if (typeof start === "string" && typeof end === "string") {
      return { iso: null as any, range: { start, end } };
    }
  }

  // 3) fallback: coba parse jam HH:MM dari queryText, tanggal default hari ini
  // (minimal: biar tidak selalu 23:59 tanpa alasan)
  const m = (queryText ?? "").match(/\b(?:jam|pukul)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i);
  if (m) {
    const hh = String(Math.min(23, Math.max(0, Number(m[1])))).padStart(2, "0");
    const mm = String(Math.min(59, Math.max(0, Number(m[2] ?? "0")))).padStart(2, "0");
    // ISO tanpa timezone -> biar Supabase parse sebagai UTC; untuk sederhana, kita kirim "YYYY-MM-DDTHH:MM:00+07:00"
    const now = new Date();
    const y = now.getFullYear();
    const mon = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const iso = `${y}-${mon}-${d}T${hh}:${mm}:00+07:00`;
    return { iso, range: null };
  }

  // fallback terakhir: null (nanti default di add_task -> end of day)
  return { iso: null as any, range: null as null | { start: string; end: string } };
}

function formatIdDateTime(iso: string) {
  // tampilan rapi untuk user (WIB)
  try {
    const dt = new Date(iso);
    const fmt = new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return fmt.format(dt).replace(".", ""); // kadang "Des." -> "Des"
  } catch {
    return iso;
  }
}

/** Ambil title: prioritas ke params.title dulu, kalau kosong coba ekstrak dari queryText */
function extractTitle(params: DFParameters, queryText: string) {
  let title = asString(params.title ?? params.task_title ?? params["judul"], "").trim();

  // kalau title salah kayak "untuk", "tugas", dll -> coba fallback
  if (!title || /^untuk$/i.test(title) || /^tugas$/i.test(title)) {
    // coba pola umum: "tambah tugas <TITLE> untuk <COURSE>"
    const t = queryText ?? "";
    const m = t.match(/(?:tambah|buat|catat)\s+tugas\s+(.+?)\s+untuk\s+/i);
    if (m?.[1]) title = m[1].trim();
  }

  return title;
}

function extractCourse(params: DFParameters, queryText: string) {
  // @course kamu IS LIST di add_task → ambil first
  let course = sanitizeCourse(params.course ?? params["mata_kuliah"] ?? params["mk"]);

  if (!course) {
    // fallback: cari "untuk X"
    const t = queryText ?? "";
    const m = t.match(/\buntuk\s+([a-z0-9 ]{2,30})\b/i);
    if (m?.[1]) course = sanitizeCourse(m[1]);
  }

  return course || "umum";
}

export const POST: APIRoute = async ({ request }) => {
  const body = (await request.json()) as DFRequestBody;

  const intentName = normalizeIntent(body.queryResult?.intent?.displayName);
  const params = body.queryResult?.parameters ?? {};
  const queryText = body.queryResult?.queryText ?? "";

  // sementara: single user
  const userId = "demo";

  try {
    // =========================
    // INTENT: add_task
    // Params (sesuai screenshot):
    // - title (@sys.any)
    // - course (@course, list)
    // - date-time (@sys.date-time, list)
    // priority: kita parse dari queryText (atau tambah param sendiri nanti)
    // =========================
    if (intentName === "add_task") {
      const title = extractTitle(params, queryText);
      if (!title) return ok("Judul tugasnya apa? (contoh: “Quiz 2”, “Laporan Praktikum”)");

      const course = extractCourse(params, queryText);

      const { iso } = extractDateTime(params, queryText);
      // kalau DF tidak kasih date-time, default end of day WIB
      const dueIso = iso || (() => {
        const now = new Date();
        const y = now.getFullYear();
        const mon = String(now.getMonth() + 1).padStart(2, "0");
        const d = String(now.getDate()).padStart(2, "0");
        return `${y}-${mon}-${d}T23:59:00+07:00`;
      })();

      const priority = parsePriorityFromText(queryText);

      const { error } = await supabase.from("tasks").insert({
        user_id: userId,
        title: title.trim(),
        course,
        due_at: dueIso, // pastikan kolom due_at = timestamptz
        priority,
        status: "todo",
      });

      if (error) throw error;

      const reply =
        `✅ Oke, sudah aku simpan.\n` +
        `• Tugas: ${title.trim()}\n` +
        `• MK: ${course}\n` +
        `• Deadline: ${formatIdDateTime(dueIso)}\n` +
        `• Prioritas: ${priorityLabel(priority)}`;

      return ok(reply);
    }

    // =========================
    // INTENT: list_tasks_by_course
    // Params:
    // - course (@course)
    // - status (@status) -> optional
    // =========================
    if (intentName === "list_tasks_by_course") {
      const course = extractCourse(params, queryText);
      const statusRaw = asString(params.status, "").toLowerCase();

      // map status yang mungkin kamu pakai di entity @status
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

      // default: kalau user tidak spesifik status, tampilkan yang belum done
      if (status) q = q.eq("status", status);
      else q = q.neq("status", "done");

      const { data, error } = await q.order("due_at", { ascending: true });
      if (error) throw error;

      if (!data || data.length === 0) {
        return ok(`Tidak ada tugas untuk ${course}${status ? ` (status: ${status})` : ""}.`);
      }

      const lines = data.slice(0, 10).map((r) => {
        const dt = r.due_at ? formatIdDateTime(String(r.due_at)) : "-";
        return `• ${r.title} — ${dt} (${priorityLabel(r.priority)}, ${r.status})`;
      });

      const more = data.length > 10 ? `\n…dan ${data.length - 10} lainnya.` : "";
      return ok(`📚 Tugas untuk ${course}:\n${lines.join("\n")}${more}`);
    }

    // =========================
    // INTENT: list_tasks_by_date
    // Params:
    // - date-time (@sys.date-time) (bisa range)
    // =========================
    if (intentName === "list_tasks_by_date") {
      const { iso, ensure, range } = { ...extractDateTime(params, queryText), ensure: true } as any;

      // kalau DF kasih range (minggu ini / 3 hari ke depan)
      if (range?.start && range?.end) {
        const { data, error } = await supabase
          .from("tasks")
          .select("title, course, due_at, priority, status")
          .eq("user_id", userId)
          .gte("due_at", range.start)
          .lte("due_at", range.end)
          .neq("status", "done")
          .order("due_at", { ascending: true });

        if (error) throw error;

        if (!data || data.length === 0) return ok("Tidak ada tugas (yang belum selesai) di rentang waktu itu.");

        const lines = data.slice(0, 10).map((r) =>
          `• ${r.title} [${r.course}] — ${formatIdDateTime(String(r.due_at))} (${priorityLabel(r.priority)})`
        );

        const more = data.length > 10 ? `\n…dan ${data.length - 10} lainnya.` : "";
        return ok(`🗓️ Tugas dalam periode itu:\n${lines.join("\n")}${more}`);
      }

      // kalau DF kasih date-time tunggal, kita cari satu hari (00:00-23:59 WIB)
      const baseIso = iso;
      if (!baseIso) return ok("Tanggal berapa? (contoh: “besok”, “hari ini”, atau “tanggal 20 November”)");

      // ambil tanggalnya saja berdasarkan Asia/Jakarta
      const dt = new Date(baseIso);
      const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(dt); // YYYY-MM-DD
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
        `• ${r.title} [${r.course}] — ${formatIdDateTime(String(r.due_at))} (${priorityLabel(r.priority)})`
      );
      const more = data.length > 10 ? `\n…dan ${data.length - 10} lainnya.` : "";

      return ok(`🗓️ Tugas pada ${ymd}:\n${lines.join("\n")}${more}`);
    }

    // =========================
    // INTENT: update_status
    // Screenshot kamu belum ada param "title" di table, tapi training phrases punya "tugas <judul>"
    // Jadi kita ambil judul dari queryText, lalu ubah status.
    // =========================
    if (intentName === "update_status") {
      const statusRaw = asString(params.status, "").toLowerCase();

      const mapStatus: Record<string, "todo" | "in_progress" | "done"> = {
        todo: "todo", "to do": "todo", belum: "todo",
        "in progress": "in_progress", progres: "in_progress", proses: "in_progress", in_progress: "in_progress",
        done: "done", selesai: "done", beres: "done",
      };

      const status = mapStatus[statusRaw];
      if (!status) return ok("Statusnya mau jadi apa? (todo / in progress / selesai)");

      // Ambil judul dari queryText: "ubah status tugas <TITLE> jadi ..."
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

    // fallback
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




