// npm run setup-answers: terminal wizard that builds <data folder>/answers.json from the template, one question at
// a time. It never overwrites an existing file (a second run resumes: only what is missing is asked) and saves
// after every accepted answer, so quitting at any point keeps the progress. Same checks as the MCP tool answers_check.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { answersFile, loadAnswers, type Answers } from "../answers/bank.js";
import {
  FIELDS, applyUpdates, checkAnswers, fieldMax, findSkillKey, getAt, initAnswers, isMissing, parseBool, parseNumber, saveAnswers,
  type Check, type Field, type SkillInput,
} from "../answers/setup.js";

export type WizardIo = { ask(q: string): Promise<string>; say(s: string): void };

/** Thrown by the terminal `ask` when the input ends (Ctrl+C, Ctrl+D, closed pipe). Not an error: progress is already saved. */
export class InputEnded extends Error {
  constructor() {
    super("Entrada encerrada.");
    this.name = "InputEnded";
  }
}

const MAX_TRIES = 3;
const MAX_SKILL_NAME = 60;

function questionText(f: Field): string {
  const lines = [f.label];
  if (f.hint) lines.push(`  (${f.hint})`);
  if (f.choices) lines.push(`  Opções: ${f.choices.map((c, i) => (f.kind === "choice" ? `${i + 1}) ${c}` : c)).join("   ")}`);
  return lines.join("\n");
}

const choiceOf = (choices: string[], s: string) => choices.find((c) => c.toLowerCase() === s.trim().toLowerCase());

/** Raw text from the terminal -> the value for the field's kind, or the reason (Portuguese) it was refused. */
function parseAnswer(f: Field, raw: string): { value: unknown } | { error: string } {
  const choices = f.choices ?? [];
  switch (f.kind) {
    case "list": {
      const items = raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean);
      if (!items.length) return { error: "Digite pelo menos um item, separados por vírgula." };
      if (!choices.length) return { value: items };
      const out: string[] = [];
      for (const it of items) {
        const c = choiceOf(choices, it);
        if (!c) return { error: `"${it}" não é uma opção. Use: ${choices.join(", ")}.` };
        out.push(c);
      }
      return { value: out };
    }
    case "choice": {
      const n = /^\d+$/.test(raw.trim()) ? Number(raw) : 0;
      const c = n >= 1 && n <= choices.length ? choices[n - 1] : choiceOf(choices, raw);
      return c ? { value: c } : { error: `Escolha um número de 1 a ${choices.length} ou um destes: ${choices.join(", ")}.` };
    }
    case "bool": {
      const b = parseBool(raw);
      return b === null ? { error: "Responda s ou n (sim/não, yes/no)." } : { value: b };
    }
    case "number": {
      // Money: "R$ 5.000" and "5.000,50" use the dot for thousands.
      const t = f.path.startsWith("compensation.") ? raw.replace(/^R\$\s*/i, "").replace(/\.(?=\d{3}(\D|$))/g, "") : raw;
      const n = parseNumber(t);
      if (n === null) return { error: "Digite um número, por exemplo 3 ou 3,5." };
      return n > fieldMax(f) ? { error: `Esse número é grande demais (o máximo aqui é ${fieldMax(f)}).` } : { value: n };
    }
    default:
      return { value: raw };
  }
}

/** profile.total_years_experience when the bank already has it as a number, else null. */
function knownTotal(bank: Answers): number | null {
  const t = getAt(bank, "profile.total_years_experience");
  return typeof t === "number" ? t : null;
}
const overTotal = (total: number) => `  Isso é mais que os ${total} anos de experiência total que você informou.`;

const SKIP = "  Não consegui aceitar a resposta; pulando esta pergunta. Responda depois rodando o assistente de novo ou pedindo ao Claude (answers_check).";

async function askField(io: WizardIo, file: string, bank: Answers, f: Field): Promise<Answers> {
  for (let tries = 0; tries < MAX_TRIES; tries++) {
    const raw = (await io.ask(questionText(f))).trim();
    if (!raw) return bank; // Enter = skip
    const p = parseAnswer(f, raw);
    if ("error" in p) {
      io.say(`  ${p.error}`);
      continue;
    }
    const total = knownTotal(bank);
    if (f.path === "profile.years_in_data" && total !== null && (p.value as number) > total) {
      io.say(overTotal(total));
      continue;
    }
    try {
      const next = applyUpdates(bank, [{ path: f.path, value: p.value }]);
      saveAnswers(file, next);
      return next;
    } catch (e) {
      io.say(`  ${(e as Error).message}`);
    }
  }
  io.say(SKIP);
  return bank;
}

async function askSkills(io: WizardIo, file: string, start: Answers): Promise<Answers> {
  let bank = start;
  const raw = (await io.ask("Quais ferramentas/skills você usa? (separadas por vírgula)\n  (só as que você realmente sabe usar; o que não estiver na lista é respondido como 0 anos / Não)")).trim();
  if (!raw) return bank;
  // One entry per skill: names that are the same skill (key or alias, any case) collapse into the first typed.
  const seen = new Set<string>();
  const names: { name: string; key: string }[] = [];
  for (const name of raw.split(/[,;]/).map((x) => x.trim()).filter(Boolean)) {
    const key = findSkillKey(bank, name) ?? name;
    const id = key.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (name.length > MAX_SKILL_NAME) {
      io.say(`  O nome "${name.slice(0, 30)}..." tem mais de ${MAX_SKILL_NAME} caracteres; pulando esta skill. Use um nome mais curto.`);
      continue;
    }
    names.push({ name, key });
  }
  for (const { name, key } of names) {
    let years: number | null = null;
    for (let tries = 0; tries < MAX_TRIES; tries++) {
      const a = (await io.ask(`Há quantos anos você usa ${name}? (número; Enter = não sei)`)).trim();
      if (!a) break;
      const n = parseNumber(a);
      const total = knownTotal(bank);
      if (n === null || n > 60) io.say("  Digite um número de anos, por exemplo 2 ou 1,5.");
      else if (total !== null && n > total) io.say(overTotal(total));
      else {
        years = n;
        break;
      }
      if (tries === MAX_TRIES - 1) io.say(`  Pulando os anos de ${name} (ficam em branco).`);
    }
    const skill: SkillInput = { key, years, knows: true };
    try {
      bank = applyUpdates(bank, [], [skill]);
      saveAnswers(file, bank);
    } catch (e) {
      io.say(`  Não consegui salvar ${name}: ${(e as Error).message}`);
    }
  }
  return bank;
}

function summary(io: WizardIo, file: string, c: Check): void {
  io.say("");
  if (c.ready_to_apply) io.say("Tudo pronto: o banco tem o necessário para as candidaturas.");
  else {
    io.say("Ainda falta para as candidaturas:");
    for (const m of c.missing.required) io.say(`  - ${m.path}: ${m.label}`);
    if (!c.skills.count) io.say("  - nenhuma skill marcada como conhecida (skills[].knows)");
    for (const i of c.inconsistencies) io.say(`  - inconsistência: ${i}`);
  }
  if (c.missing.recommended.length) io.say(`Recomendado, ainda em branco: ${c.missing.recommended.map((m) => m.path).join(", ")}`);
  if (c.placeholders.length) io.say(`Ainda com <...> do modelo: ${c.placeholders.join(", ")}`);
  io.say(`Você pode conferir a qualquer momento pedindo ao Claude "answers_check", ou editar o arquivo à mão: ${file}`);
}

/**
 * The whole interview. `io` is the terminal in production and a script in tests. Returns the final check.
 * Throws only when `io.ask` does (e.g. the input ended): everything accepted so far is already on disk.
 */
export async function runWizard(io: WizardIo, file: string): Promise<Check> {
  io.say(`Arquivo do banco de respostas: ${file}`);
  const init = initAnswers(file); // never overwrites
  io.say(init.created ? "Arquivo criado a partir do modelo." : "O arquivo já existe: retomando de onde parou (nada será apagado).");
  io.say("Responda uma pergunta por vez. Enter vazio pula a pergunta. Tudo fica só neste arquivo, no seu computador.\n");

  let bank = loadAnswers(file) as Answers;
  const check = checkAnswers(bank);
  for (const info of [...check.missing.required, ...check.missing.recommended]) {
    const f = FIELDS.find((x) => x.path === info.path) as Field;
    bank = await askField(io, file, bank, f);
  }

  if (checkAnswers(bank).skills.count === 0) bank = await askSkills(io, file, bank);

  const sensitive = FIELDS.filter((f) => f.sensitive && isMissing(getAt(bank, f.path)));
  if (sensitive.length) {
    const a = await io.ask("Quer preencher também os dados sensíveis (CPF e pretensão salarial)? Ficam só neste arquivo local. (s/N)");
    if (parseBool(a) === true) for (const f of sensitive) bank = await askField(io, file, bank, f);
  }

  const final = checkAnswers(loadAnswers(file));
  summary(io, file, final);
  return final;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Lines are queued as they arrive: piped input delivers several at once, before the next question is asked.
  const lines: string[] = [];
  const waiting: ((l: string | null) => void)[] = [];
  let closed = false;
  rl.on("line", (l) => {
    const w = waiting.shift();
    if (w) w(l);
    else lines.push(l);
  });
  rl.on("close", () => {
    closed = true;
    for (const w of waiting.splice(0)) w(null);
  });
  rl.on("SIGINT", () => rl.close()); // Ctrl+C leaves through the same path as the end of the input
  const nextLine =() => (lines.length ? Promise.resolve(lines.shift() as string) : closed ? Promise.resolve(null) : new Promise<string | null>((r) => waiting.push(r)));
  const io: WizardIo = {
    say: (s) => console.log(s),
    ask: async (q) => {
      if (closed && !lines.length) throw new InputEnded();
      console.log(q);
      if (!closed) {
        rl.setPrompt("> ");
        rl.prompt();
      }
      const l = await nextLine();
      if (l !== null && !process.stdin.isTTY) console.log(l); // piped input: show it, so a log reads like the session
      if (l === null) throw new InputEnded();
      return l;
    },
  };
  try {
    await runWizard(io, answersFile());
  } catch (e) {
    if (e instanceof InputEnded) {
      // Ctrl+C or the end of the input: everything accepted so far is already on disk, so this is a normal exit.
      console.log("\n\nInterrompido. O que você já respondeu foi salvo; rode `npm run setup-answers` de novo para continuar de onde parou.");
      return;
    }
    console.error(`\n${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}

// Only when run directly (npm run setup-answers), so tests can import runWizard.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
