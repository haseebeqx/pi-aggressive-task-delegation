// Per-delegation review is optional; the whole-item task-list gate is not.
export const reviewGuidance = `Independent review defaults to true. Set review:false only for low-risk, narrow
work with concrete worker verification, or to avoid redundant nested reviews.
Keep review for risky, security-sensitive or broad changes, uncertain verification,
or explicit user requirements. Skipping review never skips worker verification.
A review-skipped completion is not PASS or independent approval; integrate its
worker report with that limitation. Non-interactive task-list whole-item review
is mandatory.`;

// The verdict is the first non-empty line, tolerating markdown emphasis and
// trailing punctuation ("**PASS**", "PASS."). Anything else, including
// "PASS with caveats", is not approval.
export function isPass(report) {
  const first = String(report ?? '').trim().split(/\r?\n/, 1)[0];
  return /^[\s#>*_`]*PASS[\s*_`.!:]*$/.test(first);
}
