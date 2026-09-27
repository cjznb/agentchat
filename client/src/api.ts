import { rosterTreeSchema, type RosterNode } from "../../shared/contracts"

export type ApiState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "error"; readonly message: string }

export async function loadRoster(signal?: AbortSignal): Promise<readonly RosterNode[]> {
  const response = await fetch("/api/roster", signal === undefined ? {} : { signal })
  if (!response.ok) throw new Error(`roster request failed: ${response.status}`)
  return rosterTreeSchema.parse(await response.json())
}
