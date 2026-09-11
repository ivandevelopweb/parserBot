# Neon optimization benchmark: luna-fixes

Generated with Node v24.21.0 on artificial pg-mem data.

Result bytes are UTF-8 sizes of JSON-serialized returned rows. They are an approximation, not PostgreSQL wire traffic and not a Neon counter.

| Provider | Scenario | SQL calls | Returned rows | Changed rows | Approx result bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| eschool | baseline | 8 | 120 | 121 | 14343 |
| eschool | unchanged | 7 | 241 | 0 | 270128 |
| eschool | single-change | 11 | 244 | 2 | 293645 |
| eschool | missing-one | 11 | 242 | 3 | 291651 |
| eschool | status-change | — | — | — | — |
| classroom | baseline | 13 | 120 | 123 | 6406 |
| classroom | unchanged | 11 | 362 | 1 | 392821 |
| classroom | single-change | 14 | 365 | 3 | 409867 |
| classroom | missing-one | 14 | 362 | 3 | 406893 |
| classroom | status-change | 14 | 365 | 2 | 394939 |
| combined | all applicable scenarios | 103 | 2421 | 258 | 2480693 |

## Comparison to the saved before run

| Provider | Scenario | SQL calls before → after | Returned rows before → after | Changed rows before → after | Approx bytes before → after |
| --- | --- | ---: | ---: | ---: | ---: |
| eschool | baseline | 8 → 8 (+0) | 120 → 120 (+0) | 121 → 121 (+0) | 14343 → 14343 (+0) |
| eschool | unchanged | 7 → 7 (+0) | 241 → 241 (+0) | 0 → 0 (+0) | 270128 → 270128 (+0) |
| eschool | single-change | 11 → 11 (+0) | 244 → 244 (+0) | 2 → 2 (+0) | 293645 → 293645 (+0) |
| eschool | missing-one | 11 → 11 (+0) | 242 → 242 (+0) | 3 → 3 (+0) | 291651 → 291651 (+0) |
| eschool | status-change | — | — | — | — |
| classroom | baseline | 13 → 13 (+0) | 120 → 120 (+0) | 123 → 123 (+0) | 6406 → 6406 (+0) |
| classroom | unchanged | 11 → 11 (+0) | 362 → 362 (+0) | 1 → 1 (+0) | 392821 → 392821 (+0) |
| classroom | single-change | 14 → 14 (+0) | 365 → 365 (+0) | 3 → 3 (+0) | 409867 → 409867 (+0) |
| classroom | missing-one | 14 → 14 (+0) | 362 → 362 (+0) | 3 → 3 (+0) | 406893 → 406893 (+0) |
| classroom | status-change | 14 → 14 (+0) | 365 → 365 (+0) | 2 → 2 (+0) | 394939 → 394939 (+0) |
| combined | baseline | 21 → 21 (+0) | 240 → 240 (+0) | 244 → 244 (+0) | 20749 → 20749 (+0) |
| combined | unchanged | 18 → 18 (+0) | 603 → 603 (+0) | 1 → 1 (+0) | 662949 → 662949 (+0) |
| combined | single-change | 25 → 25 (+0) | 609 → 609 (+0) | 5 → 5 (+0) | 703512 → 703512 (+0) |
| combined | missing-one | 25 → 25 (+0) | 604 → 604 (+0) | 6 → 6 (+0) | 698544 → 698544 (+0) |
| combined | status-change | 14 → 14 (+0) | 365 → 365 (+0) | 2 → 2 (+0) | 394939 → 394939 (+0) |
