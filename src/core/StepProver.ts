import {
  StepConfig,
  StepResult,
  PrimusAttestationResult,
  VeritasError,
  VeritasErrorCode,
} from "../types/index.js";
import { sha256, bodyContainsHash } from "../utils/hash.js";
import { isTrustedDomain } from "../utils/domain.js";

/**
 * StepProver handles the execution of a single proof step.
 *
 * Responsibilities:
 *  1. Optional off-chain domain check (if trustedDomains provided)
 *  2. Enforce chain linkage: if dependsOn is set, verify the body
 *     contains SHA256(parentStep.data[sourceField])
 *  3. Execute the Primus core-sdk attestation flow off-chain
 *  4. Validate the returned attestation signature off-chain with the SDK
 *  5. Return a StepResult with parsed data and dataHash
 */
export class StepProver {
  private readonly trustedDomains?: Set<string>;

  constructor(
    private readonly primusCore: any,
    opts?: { trustedDomains?: Iterable<string> },
  ) {
    this.trustedDomains = opts?.trustedDomains
      ? new Set(opts.trustedDomains)
      : undefined;
  }

  private isWrappedAttestationResult(value: any): boolean {
    return Boolean(
      value &&
      typeof value === "object" &&
      value.attestation &&
      typeof value.attestation === "object" &&
      typeof value.signature === "string",
    );
  }

  private isOfficialAttestation(value: any): boolean {
    return Boolean(
      value &&
      typeof value === "object" &&
      typeof value.recipient === "string" &&
      value.request &&
      Array.isArray(value.signatures),
    );
  }

  private toVerificationPayload(raw: any): any {
    if (this.isOfficialAttestation(raw)) {
      return raw;
    }

    if (this.isWrappedAttestationResult(raw)) {
      return {
        recipient: raw.attestation.recipient,
        request: raw.attestation.request,
        reponseResolve: raw.attestation.responseResolve ?? [],
        data: raw.attestation.data,
        attConditions: raw.attestation.attConditions,
        timestamp: raw.attestation.timestamp,
        additionParams: raw.attestation.additionParams,
        attestors: [
          {
            attestorAddr: raw.attestor,
            url: raw.attestorUrl,
          },
        ],
        signatures: [raw.signature],
      };
    }

    return raw;
  }

  private normalizeAttestationResult(raw: any): PrimusAttestationResult {
    if (this.isWrappedAttestationResult(raw)) {
      return raw as PrimusAttestationResult;
    }

    if (!this.isOfficialAttestation(raw)) {
      throw new VeritasError(
        `Unexpected Primus attestation result shape`,
        VeritasErrorCode.ATTESTATION_INVALID,
      );
    }

    const synthesizedTaskId = sha256(JSON.stringify(raw));

    return {
      attestation: {
        recipient: raw.recipient,
        request: {
          url: raw.request?.url ?? "",
          header: typeof raw.request?.header === "string"
            ? raw.request.header
            : JSON.stringify(raw.request?.header ?? {}),
          method: raw.request?.method ?? "GET",
          body: raw.request?.body ?? "",
        },
        responseResolve: raw.responseResolve ?? raw.reponseResolve ?? [],
        data: raw.data ?? "",
        attConditions: raw.attConditions ?? "",
        timestamp: Number(raw.timestamp ?? Date.now()),
        additionParams: raw.additionParams ?? "",
      },
      attestor: raw.attestors?.[0]?.attestorAddr ?? "",
      signature: raw.signatures?.[0] ?? "0x",
      reportTxHash: "",
      taskId: synthesizedTaskId,
      attestationTime: 0,
      attestorUrl: raw.attestors?.[0]?.url ?? "",
    };
  }

  private parseAttestedData(rawData: string): Record<string, string> {
    try {
      const parsed = JSON.parse(rawData);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { raw: rawData };
      }

      const normalized: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          try {
            const inner = JSON.parse(value);
            normalized[key] = typeof inner === "string"
              ? inner
              : JSON.stringify(inner);
          } catch {
            normalized[key] = value;
          }
        } else {
          normalized[key] = JSON.stringify(value);
        }
      }
      return normalized;
    } catch {
      return { raw: rawData };
    }
  }

  async prove(
    config: StepConfig,
    prevSteps: Record<string, StepResult>,
    providerWallet: string,
  ): Promise<StepResult> {
    const mode = config.mode ?? "proxytls";
    // ── 1. Optional off-chain domain check ──────────────────
    // Only enforced when the caller passes a trustedDomains set.
    // If omitted, all domains are allowed at the SDK level.
    // On-chain domain enforcement belongs in IEvaluatorPolicy contracts.
    if (!isTrustedDomain(config.url, this.trustedDomains)) {
      throw new VeritasError(
        `Domain not in configured trustedDomains: ${config.url}`,
        VeritasErrorCode.UNTRUSTED_DOMAIN,
        config.stepId,
      );
    }

    // ── 2. Build request body ───────────────────────────────
    let body = "";
    if (config.bodyBuilder) {
      body = config.bodyBuilder(prevSteps);
    } else if (config.body) {
      body = config.body;
    }

    // ── 3. Enforce chain linkage ────────────────────────────
    if (config.dependsOn) {
      const { stepId: parentId, sourceField } = config.dependsOn;
      const parent = prevSteps[parentId];

      if (!parent) {
        throw new VeritasError(
          `dependsOn step "${parentId}" has not been proven yet`,
          VeritasErrorCode.STEP_NOT_FOUND,
          config.stepId,
        );
      }

      const parentFieldValue = parent.data[sourceField];
      if (!parentFieldValue) {
        throw new VeritasError(
          `Field "${sourceField}" not found in parent step "${parentId}" data`,
          VeritasErrorCode.STEP_NOT_FOUND,
          config.stepId,
        );
      }

      const parentRawData = parent.attestation.attestation.data;
      if (!bodyContainsHash(body, parentRawData)) {
        throw new VeritasError(
          `Chain linkage broken: body does not contain SHA256(${parentId}.attestation.data). ` +
          `Use buildHashReference() with the parent step's raw attestation data.`,
          VeritasErrorCode.CHAIN_LINKAGE_BROKEN,
          config.stepId,
        );
      }
    }

    // ── 4. Execute Primus Core SDK attestation off-chain ─────
    // Core-SDK flow:
    //   generateRequestParams(request, responseResolves)
    //   setAttMode({ algorithmType })
    //   startAttestation(generateRequest)
    const request = {
      url: config.url,
      method: config.method,
      header: config.headers,
      body,
    };

    // Core-SDK example uses { keyName, parsePath }.
    // We keep compatibility with our richer type by mapping through.
    const responseResolves = config.responseResolves.map((r) => ({
      keyName: r.keyName,
      parsePath: r.parsePath,
      parseType: r.parseType,
      op: r.op,
      value: r.value,
    }));

    let generateRequest: any;
    try {
      generateRequest = this.primusCore.generateRequestParams(
        request,
        responseResolves,
        providerWallet,
      );
    } catch (err: any) {
      throw new VeritasError(
        `Primus generateRequestParams failed: ${err?.message ?? String(err)}`,
        VeritasErrorCode.PRIMUS_INIT_FAILED,
        config.stepId,
      );
    }

    try {
      generateRequest.setAttMode({ algorithmType: mode });
    } catch {
      // Some SDK versions may not require explicit mode set here.
    }

    let rawAttestResult: any;
    try {
      rawAttestResult = await this.primusCore.startAttestation(generateRequest);
    } catch (err: any) {
      throw new VeritasError(
        `Primus startAttestation failed: ${err?.message ?? String(err)}`,
        VeritasErrorCode.PRIMUS_INIT_FAILED,
        config.stepId,
      );
    }

    // ── 5. Validate attestation signature off-chain ─────────
    const verificationPayload = this.toVerificationPayload(rawAttestResult);
    const isValid = this.primusCore.verifyAttestation(verificationPayload);
    if (!isValid) {
      throw new VeritasError(
        `Attestation signature invalid for step: ${config.stepId}`,
        VeritasErrorCode.ATTESTATION_INVALID,
        config.stepId,
      );
    }

    const attestResult = this.normalizeAttestationResult(rawAttestResult);

    // ── 6. Validate recipient matches provider wallet ────────
    if (
      attestResult.attestation.recipient.toLowerCase() !==
      providerWallet.toLowerCase()
    ) {
      throw new VeritasError(
        `Attestation recipient ${attestResult.attestation.recipient} does not match provider wallet ${providerWallet}`,
        VeritasErrorCode.RECIPIENT_MISMATCH,
        config.stepId,
      );
    }

    // ── 7. Parse extracted data ──────────────────────────────
    const parsedData = this.parseAttestedData(attestResult.attestation.data);

    const dataHash = sha256(attestResult.attestation.data);

    return {
      stepId: config.stepId,
      data: parsedData,
      dataHash,
      attestation: attestResult,
      executedAt: Date.now(),
    };
  }
}
