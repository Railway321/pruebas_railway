import { parseString } from "fast-csv";

export interface InsertReview {
  source: "booking";
  externalId?: string;
  guestName?: string;
  guestEmail?: string;
  reservationId?: string;
  rating: number;
  title?: string;
  content: string;
  reviewDate: string;
}

const COLUMN_MAP: Record<string, keyof CsvRow> = {
  review_id: "externalId",
  "review id": "externalId",
  id: "externalId",
  external_id: "externalId",
  guest_name: "guestName",
  "guest name": "guestName",
  guest: "guestName",
  reviewer: "guestName",
  author: "guestName",
  rating: "rating",
  score: "rating",
  average_rating: "rating",
  "review score": "rating",
  puntuacion: "rating",
  title: "title",
  review_title: "title",
  "review title": "title",
  subject: "title",
  titulo: "title",
  content: "content",
  review_text: "content",
  "review text": "content",
  text: "content",
  review: "content",
  comentario: "content",
  descripcion: "content",
  review_date: "reviewDate",
  "review date": "reviewDate",
  date: "reviewDate",
  reviewed_date: "reviewDate",
  fecha: "reviewDate",
  reservation_id: "reservationId",
  "reservation id": "reservationId",
  "reservation number": "reservationId",
  reservation: "reservationId",
  booking_id: "reservationId",
  reserva: "reservationId",
  "fecha del comentario": "reviewDate",
  "nombre del cliente": "guestName",
  "número de reserva": "reservationId",
  "numero de reserva": "reservationId",
  "título del comentario": "title",
  "titulo del comentario": "title",
  "comentario positivo": "content",
  "comentario negativo": "content",
  "puntuación del comentario": "rating",
  "puntuacion del comentario": "rating",
};

interface CsvRow {
  externalId?: string;
  guestName?: string;
  rating?: number;
  title?: string;
  content?: string;
  reviewDate?: string;
  reservationId?: string;
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseRating(value: unknown): number {
  if (value === null || value === undefined || value === "") return 8;
  const num = Number(value);
  if (Number.isNaN(num)) return 8;
  if (num < 1 || num > 10) return Math.max(1, Math.min(10, Math.round(num)));
  return Math.round(num);
}

function parseDate(value: unknown): string | null {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function getStartOfYear(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
}

export async function parseBookingCsv(
  buffer: Buffer
): Promise<{ rows: InsertReview[]; errors: string[] }> {
  const errors: string[] = [];
  const rows: InsertReview[] = [];
  let headerMapBuilt = false;

  const buildHeaderMap = (row: Record<string, string>) => {
    const result: Record<string, keyof CsvRow> = {};
    for (const header of Object.keys(row)) {
      const normalized = normalizeHeader(header);
      const field = COLUMN_MAP[normalized];
      if (field) {
        result[header] = field;
      }
    }
    return result;
  };

  return new Promise((resolve, reject) => {
    let headerMap: Record<string, keyof CsvRow> = {};

    parseString(buffer.toString("utf-8"), {
      headers: true,
      trim: true,
    })
      .on("data", (rawRow: Record<string, string>) => {
        if (!headerMapBuilt) {
          headerMap = buildHeaderMap(rawRow);
          headerMapBuilt = true;
        }

        const mapped: CsvRow = {};
        for (const [column, value] of Object.entries(rawRow)) {
          const field = headerMap[column];
          if (field && value !== undefined && value !== "") {
            (mapped as Record<string, unknown>)[field] = value;
          }
        }

        let externalId = mapped.externalId?.trim();
        if (!externalId) {
          const reservationId = mapped.reservationId?.trim() || "sin-reserva";
          const date = mapped.reviewDate ?? "";
          externalId = `booking-${date}-${reservationId}`;
        }

        const positiveReview =
          rawRow["Positive review"] ?? rawRow["positive review"] ?? "";
        const negativeReview =
          rawRow["Negative review"] ?? rawRow["negative review"] ?? "";
        const combinedContent = [mapped.content, positiveReview, negativeReview]
          .filter(Boolean)
          .map((part) => part!.trim())
          .filter(Boolean)
          .join(" | ");

        const content = combinedContent || mapped.content || "";
        const fallbackContent =
          content ||
          `Reseña sin comentario (puntuación: ${parseRating(
            rawRow["Review score"] ?? rawRow["review score"] ?? mapped.rating
          )}/10)`;

        const rating = parseRating(mapped.rating);
        const reviewDate = parseDate(mapped.reviewDate);
        if (!reviewDate) {
          errors.push(`Fila sin fecha válida: ${externalId}`);
          return;
        }

        if (new Date(reviewDate) < getStartOfYear()) {
          return;
        }

        rows.push({
          source: "booking",
          externalId,
          guestName: mapped.guestName?.trim() || undefined,
          reservationId: mapped.reservationId?.trim() || undefined,
          rating,
          title: mapped.title?.trim() || undefined,
          content: fallbackContent,
          reviewDate,
        });
      })
      .on("error", (error: Error) => reject(error))
      .on("end", () => resolve({ rows, errors }));
  });
}
