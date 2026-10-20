# LinkedIn DOM map (recon of the 2026 DOM, pt-BR UI)

> Documento técnico (em inglês) com o que foi observado no DOM do LinkedIn. Visão geral em português: [README.md](README.md) · [ARCHITECTURE.md](ARCHITECTURE.md).

Raw evidence: `<dados>/page-maps/*.{json,html}`, `<dados>/form-maps/<jobId>.json` + `.stepN.html`.
(The one-off probe scripts used for this recon were removed after the findings were folded into `src/`.)

## Two DOM generations
| Page | UI | Anchor strategy |
|---|---|---|
| Job search `/jobs/search/` | legacy Ember, stable classes | `li[data-occludable-job-id]`; cards are empty until scrolled into view |
| Job view `/jobs/view/<id>/` | new, hashed classes, **no h1** | line order of `main` + `[data-testid=expandable-text-box]` (description) |
| People / company search `/search/results/...` | new, hashed classes | entity links (`/in/`, `/company/`) + repeating-sibling card finder (`src/linkedin/dom.ts`) |
| Profile `/in/<slug>/`, Company `/company/<slug>/about/` | new | line order / label-value pairs |
| Jobs tracker `/jobs-tracker/?stage=applied` | new | `/jobs/view/` links; client-side pagination via "Próxima" (hidden on last page; `?start=` ignored) |
| Easy Apply | new, native `<dialog open>` | semantic HTML (see below) |

Only `data-testid` values worth using: `lazy-column`, `expandable-text-box`, `dialog-content`, `pagination-indicator-N`.

## Card line formats
- **Job card (search):** title · company · "Local (Remoto|Híbrido|Presencial)" · insights ("Visualizado", "Avaliando candidaturas", "Promovida") · "Candidatura simplificada".
- **Job view:** company · title · "Local · há X · N candidaturas" · modality · employment type · … "Sobre a vaga" … "Requisitos adicionados pelo anunciante da vaga" + "• …" bullets · "Sobre a empresa".
- **Person card:** name [• 2º] · headline · location · action (Conectar/Seguir/Enviar mensagem) · "Atual: cargo na Empresa" · "… conexões em comum". Degree is sometimes on the name line.
- **Profile:** name · • 2º · headline · location · "Dados de contato" · company · school · "N conexões" · mutual · actions · "Sobre" …
- **Company card:** name · industry · location · "Seguir" · summary · "N seguidores". Results also include `/showcase/` pages (filtered out).
- **Company about:** pairs `Site`, `Telefone`, `Setor`, `Tamanho da empresa`, `N usuários associados`, `Sede`, `Fundação em`, `Tipo`, `Especializações`.
- **Tracker card:** title · "Empresa · Local (Modalidade)" · "Candidatou-se há 2 d" · "(Anunciada há 3 d)" | "(Não aceita mais candidaturas)". Tabs: Salvas, Em andamento, Candidaturas enviadas, Entrevistas, Arquivadas.

## Search URL facets
- Jobs: `keywords, location, f_AL=true (Easy Apply), f_WT=1|2|3 (presencial|remoto|híbrido), f_TPR=r86400|r604800|r2592000, f_E=1..6, start=25n`.
- People: `keywords, network=["F","S","O"], geoUrn=["106057199"] (Brasil), currentCompany=[ids], page=n`.
- Companies: `keywords, companySize=["B".."I"] (B=1-10, C=11-50, D=51-200, E=201-500, …), companyHqGeo=["106057199"], page=n`.

## Easy Apply form anatomy
- Root: `dialog[open]`. Header `h2` "Candidate-se à empresa X". Progress text "N de M páginas" (absent on single-page forms).
- Section title: first `p` inside `[data-testid=lazy-column]` ("Informações de contato"/"Contact info", "Currículo", "Carta de apresentação", "Experiência de trabalho", "Formação acadêmica", "Perguntas adicionais").
- Each question: `div[componentkey^="easyApplyFieldFocus_"]` containing a `<p>` with the question (trailing `*` = required) and the control.
  - Profile fields carry a semantic key: `easyApplyFieldFocus_ea.q::<id>::FIRST_NAME::firstName`, `LAST_NAME`, `PHONE_MOBILE`, `UNKNOWN`.
  - Recruiter questions: `easyApplyFieldFocus_ea_validation_p<page>_<n>_<id>`.
  - Resume block: `componentkey=easyApplyUploadedResumeRef`.
- Controls observed (8 forms, 81 fields): text 22, select 22, radio 14, tel 7, file 7, checkbox_group 4, checkbox 3, textarea 1, typeahead 1.
  - **text/tel/textarea:** `<label for=id>` or `aria-label` = question; `aria-describedby` → "7/100 · 7 de 100 caracteres" counter. Often prefilled from profile (name, phone, "years of X" with previous answers).
  - **select:** native `<select>`; first option "Selecionar opção" means unanswered. Used for email, country code, English level, yes/no consent (LGPD), diversity.
  - **radio:** `<fieldset role=radiogroup>`; each option is a custom `div[role=radio][aria-checked]` wrapping a hidden `<input type=radio>` with an **empty label**; option text in a sibling `<p>` ("Sim/Não", "Yes/No"). Resume picker is also a radiogroup ("PDF Resume_EN.pdf 01/01/2026").
  - **checkbox / checkbox_group:** consent ("Confirmado"), multi-choice (offices, certifications, courses). An unlabeled checkbox on single-page forms = "follow company".
  - **typeahead:** "Location (city)*" — needs typing + picking a suggestion.
  - **file:** no `<input type=file>` until clicked; a "Carregar"/"Carregar currículo" button with caption ("Cover letter", "DOC, DOCX, PDF").
  - Profile review pages (experience/education) only expose "Editar, …" / "Adicionar mais" buttons.
- Footer buttons: `Voltar`, `Avançar` (next), `Avaliar` (go to review), `Enviar candidatura` (**submit — never clicked by mappers**). Close: `Fechar` → confirm dialog "Salvar esta candidatura?" → `Descartar` | `Salvar`.
- Unanswered required fields keep the same page on `Avançar` (mapper reports `blocked_by_required`).

## Gotchas found
- `tsx` injects `__name()` into functions sent to `page.evaluate`; shim added in `getPage()`.
- Some forms are **single page** and show `Enviar candidatura` immediately: the executor must never click a button just because it is the primary one.
- One job (3000000003) opened a different dialog ("Avaliar anúncio de vaga") instead of the form → treat unknown dialogs as abort.
- Custom questions can ask for sensitive data (CPF, current salary/benefits, referral names, LGPD/AI-screening consent): these must come from user-approved answers, never inferred.
