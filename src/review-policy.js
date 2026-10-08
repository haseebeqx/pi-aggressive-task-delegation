// Per-delegation review is optional; the whole-item task-list gate is not.
export const reviewGuidance = `Independent review defaults to true. Set review:false only for low-risk, narrow
work with concrete worker verification, or to avoid redundant nested reviews.
Keep review for risky, security-sensitive or broad changes, uncertain verification,
or explicit user requirements. Skipping review never skips worker verification.
A review-skipped completion is not PASS or independent approval; integrate its
worker report with that limitation. Non-interactive task-list whole-item review
is mandatory.`;
