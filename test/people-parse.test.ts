// Synthetic search-card rows (fake names): the "mutual connections" text must never become a person's name.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isMutualText, nameFromButton, parsePersonCard } from "../src/linkedin/peoplePure.js";

const URL_ = "https://www.linkedin.com/in/ana-silva";

test("isMutualText: PT-BR and EN variants", () => {
  for (const s of ["Bruno Lima e mais 3 conexões em comum", "1 conexão em comum", "5 mutual connections", "Carla Souza is a mutual connection"]) {
    assert.ok(isMutualText(s), s);
  }
  assert.ok(!isMutualText("Ana Silva"));
  assert.equal(nameFromButton("Ver perfil de Ana Silva"), "Ana Silva");
  assert.equal(nameFromButton("View Ana Silva’s profile"), "Ana Silva");
  assert.equal(nameFromButton("Ver perfil de 3 conexões em comum"), "", "never a mutual-connections text");
  assert.ok(isMutualText("Ana Claudia Rösing e Romário Silva são conexões em comum"));
  assert.ok(isMutualText("Eduardo Ventura é uma conexão em comum"));
  assert.ok(!isMutualText("Mutual Fund Analyst"), "a headline with the word is not the mutual line");
  assert.ok(!isMutualText("Interesses em comum: dados"));
});

test("nameFromButton: invite / follow labels PT-BR and EN", () => {
  assert.equal(nameFromButton("Convidar Ana Silva para se conectar"), "Ana Silva");
  assert.equal(nameFromButton("Invite Ana Silva to connect"), "Ana Silva");
  assert.equal(nameFromButton("Seguir Ana Silva"), "Ana Silva");
  assert.equal(nameFromButton("Follow Ana Silva"), "Ana Silva");
  assert.equal(nameFromButton("Enviar mensagem"), "");
});

test("parsePersonCard: a normal card is unchanged", () => {
  const p = parsePersonCard(URL_, ["Ana Silva • 2º", "Recruiter na Acme", "São Paulo", "Bruno Lima e mais 3 conexões em comum", "Conectar"]);
  assert.equal(p.name, "Ana Silva");
  assert.equal(p.degree, "2º");
  assert.equal(p.headline, "Recruiter na Acme");
  assert.equal(p.mutual, "Bruno Lima e mais 3 conexões em comum");
});

test("parsePersonCard: mutual text on the first line falls back to the button label (PT-BR)", () => {
  const p = parsePersonCard(URL_, ["Bruno Lima e mais 3 conexões em comum", "Recruiter na Acme", "São Paulo", "Conectar"], ["Convidar Ana Silva para se conectar"]);
  assert.equal(p.name, "Ana Silva");
  assert.equal(p.mutual, "Bruno Lima e mais 3 conexões em comum");
  assert.equal(p.headline, "Recruiter na Acme");
});

test("parsePersonCard: mutual text on the first line falls back to the button label (EN)", () => {
  const p = parsePersonCard(URL_, ["5 mutual connections", "Tech Recruiter at Acme", "London", "Connect"], ["Invite Ana Silva to connect"]);
  assert.equal(p.name, "Ana Silva");
  assert.equal(p.mutual, "5 mutual connections");
});

test("parsePersonCard: no button -> the line right before the degree", () => {
  const p = parsePersonCard(URL_, ["1 conexão em comum", "Ana Silva", "• 2º", "Recruiter na Acme", "São Paulo"]);
  assert.equal(p.name, "Ana Silva");
  assert.equal(p.degree, "2º");
  assert.equal(p.headline, "Recruiter na Acme");
});

test("parsePersonCard: nothing trustworthy -> empty name (row is dropped by the caller)", () => {
  assert.equal(parsePersonCard(URL_, ["Bruno Lima e mais 3 conexões em comum", "Recruiter na Acme"]).name, "");
  assert.equal(parsePersonCard(URL_, ["2 mutual connections", "Recruiter at Acme"], ["Message"]).name, "");
});
