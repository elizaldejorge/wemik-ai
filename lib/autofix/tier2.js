/**
 * ClawGuard - AutoFix Tier 2 (SCAFFOLD ONLY)
 * by elizaldejorge
 *
 * ⚠️  LLM calls are DISABLED until Javier signs off on the commercial questions
 *     documented in CONTEXT/AUTOFIX_DESIGN.md (pricing, liability, licensing,
 *     SOC 2 subprocessor scope, privacy posture).
 *
 * What this file does today:
 *   - Exports proposeFix() that returns a structured "no-op, decision pending"
 *     object so the UI and command layer can integrate against a stable shape.
 *   - Documents the intended data flow so reviewers can verify the surface
 *     before any LLM call is wired in.
 *
 * What this file WILL do once enabled:
 *   1. Build a minimal context: the finding + the offending file snippet
 *      (line-limited window) + the surrounding 20 lines.
 *   2. Call the configured provider (Anthropic / OpenAI / local) with a
 *      prompt that asks for a unified diff patch only, no prose.
 *   3. Validate the returned patch (must apply cleanly, must not introduce
 *      imports we didn't expect, must not touch files outside the skill dir).
 *   4. Return the patch plus a confidence score; the UI/human approves or rejects.
 *   5. Never auto-apply; Tier 2 always requires explicit human approval.
 */

// Feature flag — flip to true ONLY after the 5 business decisions in
// CONTEXT/AUTOFIX_DESIGN.md have been resolved and captured in DECISIONS.md.
export const TIER2_ENABLED = false;

/**
 * Propose an AI-drafted fix for a Tier-2 finding.
 * Currently a scaffold that returns a "pending sign-off" response.
 *
 * @param {object} finding
 * @param {string} skillPath
 * @param {object} [options]
 * @returns {Promise<{
 *   proposed:  boolean,
 *   reason:    string,
 *   patch?:    string,
 *   model?:    string,
 *   error?:    string,
 *   pendingDecisions?: string[],
 * }>}
 */
export async function proposeFix(finding, skillPath, options = {}) {
  if (!TIER2_ENABLED) {
    return {
      proposed: false,
      reason: "tier2-disabled",
      error: "Tier 2 AI-assisted fixes are disabled pending business sign-off.",
      pendingDecisions: [
        "Who pays for LLM calls (BYOK vs bundled)",
        "Liability when AI-generated patches break a skill",
        "SOC 2 subprocessor scope for the LLM provider",
        "Open-core license boundary — MIT or BSL 1.1",
        "Privacy posture — opt-in egress, Pro-only?",
      ],
    };
  }

  // === Below: intentionally unreachable until TIER2_ENABLED flips. ===
  // Keep the signature stable so command/UI callers don't change later.
  //
  // const context = await buildContext(finding, skillPath, options);
  // const patch   = await callProvider(context, options);
  // const ok      = await validatePatch(patch, skillPath);
  // return { proposed: ok, reason: "ai-patch", patch, model: options.model };

  return { proposed: false, reason: "unreachable", error: "Tier 2 gate open but provider not wired." };
}
