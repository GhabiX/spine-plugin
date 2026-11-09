// The web client's React JSX runtime, which the client bundle takes from the
// host; only what the dock entry calls is declared.
declare module "react/jsx-runtime" {
  export function jsx(type: string, props: Record<string, unknown>, key?: string | number): unknown;
  export function jsxs(type: string, props: Record<string, unknown>, key?: string | number): unknown;
}
