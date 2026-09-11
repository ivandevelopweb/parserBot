# Neon optimization benchmark: before

Generated with Node v24.12.0 on artificial pg-mem data.

Result bytes are UTF-8 sizes of JSON-serialized returned rows. They are an approximation, not PostgreSQL wire traffic and not a Neon counter.

| Provider | Scenario | SQL calls | Returned rows | Changed rows | Approx result bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| eschool | baseline | 364 | 120 | 121 | 135648 |
| eschool | unchanged | 245 | 241 | 240 | 270366 |
| eschool | single-change | 249 | 244 | 241 | 305697 |
| eschool | missing-one | 247 | 242 | 240 | 303557 |
| eschool | status-change | — | — | — | — |
| classroom | baseline | 847 | 360 | 242 | 394064 |
| classroom | unchanged | 607 | 483 | 240 | 524482 |
| classroom | single-change | 610 | 486 | 241 | 550140 |
| classroom | missing-one | 605 | 482 | 239 | 546002 |
| classroom | status-change | 604 | 481 | 239 | 522557 |
| combined | all applicable scenarios | 4378 | 3139 | 2043 | 3552513 |
