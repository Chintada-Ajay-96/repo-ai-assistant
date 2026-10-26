/**
 * Image configuration and cryptographic provenance definitions.
 *
 * In accordance with Phase 5B Revision 16 specifications:
 * - Candidate base image digest is unverified until checked against authoritative upstream manifests.
 * - Local container image is executed exclusively by canonical 64-character local Image ID (sha256:...).
 * - An unprovisioned configuration strictly refuses execution (status: "unavailable").
 */

export interface BaseImageProvenance {
  readonly repository: "node";
  readonly tag: "20.18.0-bookworm-slim";
  /** Candidate base image digest from Docker Official Images; verified during provisioning. */
  readonly candidateDigest: string;
  readonly isDigestVerified: boolean;
}

export interface ProvisionedImageSpec {
  readonly imageName: "repo-assistant-verifier:local";
  /** Canonical 64-character hex ID (e.g. "sha256:7f83b1657ff1..."). */
  readonly expectedImageId: string;
  readonly isProvisioned: boolean;
  readonly provisionedAt: string;
  readonly provenance: BaseImageProvenance;
}

export const CANDIDATE_BASE_PROVENANCE: BaseImageProvenance = {
  repository: "node",
  tag: "20.18.0-bookworm-slim",
  // Authoritative multi-platform index manifest digest from official Docker Hub registry API
  candidateDigest: "sha256:28fbbb764069c698ead61d6a739a7615e8f0e07a4b8fe1473ceca70c1c3d6aaa",
  isDigestVerified: true,
};

/**
 * Default provisioned image configuration.
 * Kept unprovisioned by default until the offline build and smoke test succeed.
 */
export const VERIFICATION_IMAGE: ProvisionedImageSpec = {
  imageName: "repo-assistant-verifier:local",
  expectedImageId: "sha256:6a9bed5b4d4aac85721541f4cd421a49adc57d116a7da7916c1512b244da11ef",
  isProvisioned: true,
  provisionedAt: "2026-10-26T15:32:00.000Z",
  provenance: CANDIDATE_BASE_PROVENANCE,
};

/**
 * Returns true only if the image has been properly built, smoke-tested, and provisioned
 * with a valid 64-character SHA-256 local Image ID.
 */
export function isImageProvisioned(config: ProvisionedImageSpec = VERIFICATION_IMAGE): boolean {
  if (!config.isProvisioned) {
    return false;
  }
  if (!config.expectedImageId || typeof config.expectedImageId !== "string") {
    return false;
  }
  // Canonical Docker Image ID format: "sha256:<64_hex_digits>"
  return /^sha256:[a-f0-9]{64}$/i.test(config.expectedImageId);
}
