/** Which part of an SRN a parse error refers to. Mirrors `SegmentKind` in `lib/rust/srn`. */
export type SrnSegmentKind =
  | "service"
  | "organization"
  | "resource"
  | "resource type"
  | "resource id"

/** Why a string is not an SRN. Mirrors `ParseError` in `lib/rust/srn`. */
export type SrnParseErrorKind =
  | { kind: "too-long"; length: number; max: number }
  | { kind: "wrong-prefix" }
  | { kind: "segment-count"; found: number }
  | { kind: "empty-segment"; segment: SrnSegmentKind }
  | { kind: "illegal-character"; segment: SrnSegmentKind; character: string }
  | { kind: "malformed-resource"; found: string }

function describe(reason: SrnParseErrorKind): string {
  switch (reason.kind) {
    case "too-long":
      return `SRN is ${reason.length} bytes, which exceeds the ${reason.max} byte limit`
    case "wrong-prefix":
      return "SRN must start with `srn:sproutos:`"
    case "segment-count":
      return `SRN must have exactly 5 \`:\`-separated segments, found ${reason.found}`
    case "empty-segment":
      return `the ${reason.segment} segment is empty`
    case "illegal-character":
      return `the ${reason.segment} segment contains the illegal character ${JSON.stringify(reason.character)}`
    case "malformed-resource":
      return `the resource segment must be \`<type>/<id>\` or \`*\`, found \`${reason.found}\``
  }
}

export class SrnParseError extends Error {
  readonly reason: SrnParseErrorKind
  readonly input: string

  constructor(reason: SrnParseErrorKind, input: string) {
    super(describe(reason))
    this.name = "SrnParseError"
    this.reason = reason
    this.input = input
  }
}
