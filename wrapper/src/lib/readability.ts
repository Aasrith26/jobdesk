// Flesch-Kincaid grade level (INC-5): bot and onboarding text must read at grade 8 or below.

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "")
  if (!w) return 0
  if (w.length <= 3) return 1
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "")
  const groups = stripped.match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups ? groups.length : 1)
}

export function fkGrade(text: string): number {
  const clean = text.replace(/https?:\/\/\S+/g, "link").replace(/[`*_#>|]/g, " ")
  const sentences = Math.max(1, (clean.match(/[.!?]+(\s|$)|\n+/g) ?? []).length)
  const words = clean.split(/\s+/).filter((w) => /[a-z]/i.test(w))
  if (!words.length) return 0
  const syl = words.reduce((n, w) => n + syllables(w), 0)
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59
}
