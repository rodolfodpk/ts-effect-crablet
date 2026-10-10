# Plano: o que restou do `.period`

Status: **em andamento (2026-10-09)**. O `.period` (ano, mês e dia em UTC) está feito e o wallet roda nele ([ADR-0025](../adr/0025-the-framework-turns-the-period.md), [`period-rollover.md`](./period-rollover.md)). Isto é o que ficou de fora, em ordem. Decisões tomadas: semana ISO (segunda-feira) com `startsOn` opcional; o Bloco A e o guia (C1) primeiro; B1 mede antes de qualquer B2.

## Bloco A: pequenos, sem decisão de produto

- **A1. Teste de `Period.custom`** (1 h). **Feito.** Um ano fiscal que começa em abril (`{ fy }`, chave `"FY2026"`) em memória com `Scenario.at`: virada, nunca voltar, escopo pelas tags declaradas. Serve também de exemplo para o guia.
- **A2. `ctx.now` no `decide`** (3 h). **Feito** (`DecideContext`; os cinco comandos do wallet usam `now`). `Loaded` leva o instante que o modelo leu; o executor o entrega como quarto argumento `{ now: Date }` (sem modelo periódico, lê o relógio). O wallet troca `new Date()` por `ctx.now`: `depositedAt` e o período concordam, também com `TestClock`.
- **A3. Métrica de relógio atrasado** (2 h). **Feito**, sem rótulos (uma chave de período cresceria sem limite); documentada no guia, sem painel (`NO_PANEL` no teste do painel diz por quê). `crablet.period.clock_behind` (rótulos `model`, `period`) em `metrics-otel/PeriodMetrics.ts`, no lugar do log de aviso. O teste de sincronia do painel (`scripts/dashboard.test.ts`) lista as métricas e seus rótulos, e o guia `monitor-it.md` as descreve: ambos acompanham. Sem painel por enquanto.

## Bloco B: exige desenho

- **B1. Medir o custo do rastreamento** (3 h), antes de decidir B2. Uma entidade com 1.000 e 10.000 períodos; tempo do `load` no caminho comum e no de virada.
- **B2. Primitivo "o último evento que casa"** (1 a 1,5 dia), **só se B1 mostrar custo**: `EventStoreService.latest(query)` (`ORDER BY ... DESC LIMIT 1`) no Postgres e em memória, com a suíte de conformidade e o teste diferencial. Toca o contrato do armazenamento.
- **B3. Fuso e semana** (0,5 a 1 dia): `Period.day({ timeZone })`, `Period.month({ timeZone })`, `Period.week({ startsOn })` por `Intl.DateTimeFormat`. Testes: horário de verão (a hora repetida e a que não existe), chave que continua ordenando, semana ISO na virada do ano. `Period.hour` só depois de B2.

## Bloco C: acabamento

- **C1. Guia do desenvolvedor** em `docs/guides/` (exemplo do wallet, tabela de níveis, `Period.custom`).
- **C2. "Período fechado e sem reabertura"** continua um defeito (`die`): só dado corrompido chega ali; um erro tipado obrigaria todo comando a declará-lo.
- **C3. Merge de `feature/period-rollover` em `main` e push**: decisão do usuário.

## Fora do plano

`OpenWallet` abrir o primeiro extrato (decisão de produto: muda o que as views mostram). O `WalletModel` ignorar uma segunda abertura do mesmo extrato (o `test.todo` de `duplicate-statement-opening.test.ts`): só se existir um log com duplicatas.
