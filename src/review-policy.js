// Shared guidance for per-delegation review; whole-item list gates are separate.
export const reviewGuidance = `Independent review defaults to true. Set review:false for low-risk, narrow work
with concrete worker verification, or to avoid redundant nested reviews. Retain review
for risky, security-sensitive or broad changes, uncertain verification, or explicit
user requirements. Skipping independent review never skips worker verification.
A review-skipped completion is not PASS or independent approval; integrate its worker
report with that limitation. Non-interactive task-list whole-item review is mandatory.`;
