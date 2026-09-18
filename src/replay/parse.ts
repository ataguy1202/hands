/** Turn what the screen shows into the declared output type. */
export function parseValue(raw: string, parse: "text" | "money" | "number"): unknown {
  const s = raw.replace(/\s+/g, " ").trim();
  if (parse === "text") return s;
  const negative = /^\(.*\)$/.test(s) || s.includes("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || Number.isNaN(Number(digits))) return undefined;
  const n = Number(digits) * (negative ? -1 : 1);
  return parse === "money" ? Math.round(n * 100) / 100 : n;
}
