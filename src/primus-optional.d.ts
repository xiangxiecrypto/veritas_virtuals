declare module "@primuslabs/zktls-core-sdk" {
  // The official package currently ships without stable TypeScript types and may
  // be installed as an optional dependency (native build).
  // We keep this minimal to allow SDK consumers to typecheck/build without
  // requiring the optional dependency to be present.
  export const PrimusCoreTLS: any;
}

