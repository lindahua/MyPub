import { join } from "node:path";
import type { Review, ReviewState } from "./types.js";
import { Catalog } from "./catalog.js";
import { readReviewFiles } from "./imports.js";
import { atomicWriteJson, now, readJson } from "./utils.js";
import { assertReview } from "./schemas.js";
import { MyPubError } from "./errors.js";

export async function listReviews(catalog: Catalog, state?: ReviewState): Promise<Review[]> { const reviews = await readReviewFiles(catalog); return reviews.filter((review) => !state || review.state === state).sort((a, b) => b.created_at.localeCompare(a.created_at)); }
export async function getReview(catalog: Catalog, id: string): Promise<Review> { const value = await readJson<unknown>(join(catalog.reviewsDir, `${id}.json`)); assertReview(value); return value; }

export async function decideReview(catalog: Catalog, id: string, state: Exclude<ReviewState, "pending">, note?: string): Promise<Review> {
  const review = await getReview(catalog, id); if (review.state !== "pending" && review.state !== "deferred") throw new MyPubError(`Review is already ${review.state}`, "REVIEW_DECIDED");
  if (state === "accepted") {
    if (review.kind === "create" && review.proposed_publication) await catalog.add(review.proposed_publication);
    else if (review.kind === "update" && review.publication_id) { const patch: Record<string, unknown> = {}; for (const change of review.changes) patch[change.field] = change.proposed; await catalog.update(review.publication_id, patch); }
  }
  const decided: Review = { ...review, state, decided_at: now(), ...(note ? { decision_note: note } : {}) };
  await atomicWriteJson(join(catalog.reviewsDir, `${id}.json`), decided); return decided;
}
