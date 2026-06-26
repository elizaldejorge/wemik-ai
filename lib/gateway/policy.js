/**
 * Wemik Gateway — Destination Policy
 * by Jorge Elizalde
 *
 * Decides what may happen to a prompt based on (a) the most sensitive data
 * class it contains and (b) where it is going (a local sovereign model that
 * never leaves the perimeter, vs. an external cloud model). The model ALWAYS
 * receives redacted text; this policy decides whether the request proceeds
 * automatically, needs a human approver, or is blocked outright.
 *
 * Destinations:
 *   sovereign-local  — on-prem / in-country model (e.g. local Llama). No egress.
 *   external-cloud   — hosted API (GPT / Claude). Data crosses the boundary.
 *
 * Decisions:
 *   allow            — proceed (redacted) automatically
 *   require-approval — hold for human (Admin) approval before the model is called
 *   block            — refuse; never call the model
 */

export const DESTINATIONS = ["sovereign-local", "external-cloud"];

// Per-destination rule per sensitivity tier.
export const GATEWAY_POLICY = Object.freeze({
  "sovereign-local": {
    restricted:  "allow",          // stays in-country; redacted anyway
    confidential:"allow",
    internal:    "allow",
    none:        "allow",
  },
  "external-cloud": {
    restricted:  "require-approval", // restricted data leaving the perimeter needs a human
    confidential:"allow",            // redacted contact data may go to cloud
    internal:    "allow",
    none:        "allow",
  },
});

// Classes that are NEVER allowed to leave the perimeter, even redacted, even
// with approval. Credentials are the obvious one.
export const NEVER_EXTERNAL = new Set(["credential"]);

/**
 * @param {object} args
 * @param {'sovereign-local'|'external-cloud'} args.destination
 * @param {string|null} args.sensitivity   highest tier present (or null)
 * @param {string[]} args.classes          data classes present
 * @returns {{decision, reason, destination, sensitivity}}
 */
export function decide({ destination, sensitivity, classes = [] }) {
  const dest = DESTINATIONS.includes(destination) ? destination : "sovereign-local";
  const tier = sensitivity || "none";

  if (dest === "external-cloud") {
    const blockedClass = classes.find((c) => NEVER_EXTERNAL.has(c));
    if (blockedClass) {
      return {
        decision: "block", destination: dest, sensitivity: tier,
        reason: `Data class "${blockedClass}" may never leave the perimeter — blocked before any model call.`,
      };
    }
  }

  const decision = (GATEWAY_POLICY[dest] && GATEWAY_POLICY[dest][tier]) || "allow";
  const reason = decision === "require-approval"
    ? `${cap(tier)} data is leaving the perimeter to an external model — a human approver is required.`
    : decision === "block"
      ? `${cap(tier)} data is not permitted at this destination.`
      : dest === "sovereign-local"
        ? "Sovereign destination — request stays in-country and proceeds with redaction."
        : `${cap(tier)} data permitted to external model in redacted form.`;

  return { decision, destination: dest, sensitivity: tier, reason };
}

/** A display matrix for the demo UI. */
export function policyMatrix() {
  return { destinations: DESTINATIONS, rules: GATEWAY_POLICY, neverExternal: [...NEVER_EXTERNAL] };
}

function cap(s) { return String(s || "").charAt(0).toUpperCase() + String(s || "").slice(1); }

export default { decide, policyMatrix, GATEWAY_POLICY, DESTINATIONS, NEVER_EXTERNAL };
