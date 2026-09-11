# Neon optimization benchmark: after

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
| eschool | baseline | 364 → 8 (-356) | 120 → 120 (+0) | 121 → 121 (+0) | 135648 → 14343 (-121305) |
| eschool | unchanged | 245 → 7 (-238) | 241 → 241 (+0) | 240 → 0 (-240) | 270366 → 270128 (-238) |
| eschool | single-change | 249 → 11 (-238) | 244 → 244 (+0) | 241 → 2 (-239) | 305697 → 293645 (-12052) |
| eschool | missing-one | 247 → 11 (-236) | 242 → 242 (+0) | 240 → 3 (-237) | 303557 → 291651 (-11906) |
| eschool | status-change | — | — | — | — |
| classroom | baseline | 847 → 13 (-834) | 360 → 120 (-240) | 242 → 123 (-119) | 394064 → 6406 (-387658) |
| classroom | unchanged | 607 → 11 (-596) | 483 → 362 (-121) | 240 → 1 (-239) | 524482 → 392821 (-131661) |
| classroom | single-change | 610 → 14 (-596) | 486 → 365 (-121) | 241 → 3 (-238) | 550140 → 409867 (-140273) |
| classroom | missing-one | 605 → 14 (-591) | 482 → 362 (-120) | 239 → 3 (-236) | 546002 → 406893 (-139109) |
| classroom | status-change | 604 → 14 (-590) | 481 → 365 (-116) | 239 → 2 (-237) | 522557 → 394939 (-127618) |
| combined | baseline | 1211 → 21 (-1190) | 480 → 240 (-240) | 363 → 244 (-119) | 529712 → 20749 (-508963) |
| combined | unchanged | 852 → 18 (-834) | 724 → 603 (-121) | 480 → 1 (-479) | 794848 → 662949 (-131899) |
| combined | single-change | 859 → 25 (-834) | 730 → 609 (-121) | 482 → 5 (-477) | 855837 → 703512 (-152325) |
| combined | missing-one | 852 → 25 (-827) | 724 → 604 (-120) | 479 → 6 (-473) | 849559 → 698544 (-151015) |
| combined | status-change | 604 → 14 (-590) | 481 → 365 (-116) | 239 → 2 (-237) | 522557 → 394939 (-127618) |
