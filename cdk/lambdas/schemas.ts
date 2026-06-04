export interface QuizQuestion {
  question: string;
  options: [string, string, string, string];
  correctIndex: 0 | 1 | 2 | 3;
}

export interface KeyTerm {
  term: string;
  definition: string;
}

export interface Summary {
  title: string;
  sections: Array<{ heading: string; content: string }>;
}

// Strip markdown code fences that models sometimes wrap JSON in.
function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  return match ? match[1] : text.trim();
}

export function validateQuiz(raw: string): QuizQuestion[] {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 25) {
    throw new Error(
      `Quiz must have exactly 25 questions, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`,
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    const q = parsed[i] as Record<string, unknown>;
    if (!q.question || typeof q.question !== 'string') {
      throw new Error(`Question ${i}: missing question text`);
    }
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Question ${i}: must have exactly 4 options`);
    }
    if (![0, 1, 2, 3].includes(q.correctIndex as number)) {
      throw new Error(`Question ${i}: correctIndex must be 0–3`);
    }
  }
  return parsed as QuizQuestion[];
}

export function validateKeyTerms(raw: string): KeyTerm[] {
  const parsed = JSON.parse(extractJson(raw)) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 10 || parsed.length > 15) {
    throw new Error(
      `Key terms must be 10–15 items, got ${Array.isArray(parsed) ? parsed.length : 'non-array'}`,
    );
  }
  for (let i = 0; i < parsed.length; i++) {
    const t = parsed[i] as Record<string, unknown>;
    if (!t.term || typeof t.term !== 'string' || !t.term.trim()) {
      throw new Error(`Term ${i}: missing term`);
    }
    if (!t.definition || typeof t.definition !== 'string' || !t.definition.trim()) {
      throw new Error(`Term ${i}: missing definition`);
    }
  }
  return parsed as KeyTerm[];
}

export function validateSummary(raw: string): Summary {
  const parsed = JSON.parse(extractJson(raw)) as Record<string, unknown>;
  if (!parsed.title || typeof parsed.title !== 'string') {
    throw new Error('Summary missing title');
  }
  if (
    !Array.isArray(parsed.sections) ||
    parsed.sections.length < 3 ||
    parsed.sections.length > 5
  ) {
    throw new Error(
      `Summary must have 3–5 sections, got ${Array.isArray(parsed.sections) ? parsed.sections.length : 'non-array'}`,
    );
  }
  return parsed as unknown as Summary;
}
