# Quota

`/qwen-quota` renders a report, and the footer keeps a one-line summary. Both come from
the same fetch, cached in memory: 5 minutes on success, 60 seconds on failure.
`/qwen-quota refresh` bypasses the cache.

There is no single usage endpoint, and no token-count API at all. Credits are not derived
from tokens, so the report shows percentages and reset times rather than an estimate.

## Plan detection

One account can hold both plans, and the inference key says nothing about which. Two
sources are therefore probed in parallel and merged: the personal usage console and the
team seat OpenAPI. Whichever answers is the plan that exists; a plan with no data is
treated as absent, and one shared console-token renewal covers both probes.

The `sk-sp-...` key is an inference credential only: sending it to the console gateway
returns `BailianGateway.Login.NotLogined`. Quota therefore needs either a console login
through bailian-cli (`~/.bailian/config.json` holds the token) or AK/SK, which the
extension uses to mint a CLI token.

## Shapes

- **Personal Token Plan** - console gateway
  `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`. Each `per<N><Unit>Percentage`
  field is the _used_ fraction (0..1); the report inverts it to "remaining".
- **Team Token Plan** - signed OpenAPI `GetSubscriptionSeatDetails` at
  `/tokenplan/subscription/seat-detail`. Seats come from
  `Data.Items[].EquityList[].CycleSurplusValue` / `CycleTotalValue` / `CycleEndTime`;
  only `Status: NORMAL` rows are kept.

Windows are discovered from whatever `per<N><Unit>Percentage` fields the response
contains, using bailian-cli's contract (`per5HourPercentage`, `per1WeekResetTime`,
`per1MonthPercentage`). Nothing assumes a 5h/week/month set: if the plan stops returning
one, it stops being displayed. A personal plan is metered monthly, so its window is
`per1Month`. If no windows come back, the report says the limit may be unlimited instead of
inventing a period.

## Console token

Quota calls need a console session. There is no environment variable for it, exactly as in
bailian-cli: a personal or team key cannot read quota, and sending `sk-sp-...` to the
console gateway returns `BailianGateway.Login.NotLogined`. The token comes from:

1. `access_token` in `$BAILIAN_CONFIG_DIR/config.json` (default `~/.bailian/config.json`),
   written by `bl auth login --console` / `--console --token-stdin`
2. minted from AK/SK with `GenerateCLIAccessToken`
   (`https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken`,
   action `GenerateCLIAccessToken`, version `2026-02-10`, signed with ACS3-HMAC-SHA256)

AK/SK sources, in order: `BAILIAN_ACCESS_KEY_ID` / `BAILIAN_ACCESS_KEY_SECRET`
(+ `BAILIAN_SECURITY_TOKEN`), then the same `config.json`, then
`ALIBABA_CLOUD_ACCESS_KEY_ID` / `ALIBABA_CLOUD_ACCESS_KEY_SECRET`
(+ `ALIBABA_CLOUD_SECURITY_TOKEN`).

The console gateway target is taken from `console_region` / `console_site` in the same
`config.json`, falling back to the region the model base URL belongs to.

## Footer

```text
◕ 5h 82% 1w 64%  |  3h12m
● alpha 94% · beta 88%  |  29d2h
```

- The leading glyph follows the _lowest_ remaining percentage: `●` at 75%+, `◕` at 50%+,
  `◑` at 25%+, `◔` above zero, `○` at zero. Without percentages it falls back to `◔`.
- Team seats are listed side by side rather than collapsed into a worst-case number.
- The trailing value is the nearest reset, counted down from the window or seat.
- `Quota bar` replaces each percentage with a ten-cell colored bar (green at 50%+ left,
  yellow at 20%+, red below). It is skipped when `NO_COLOR` or `TERM=dumb` is set.
- `Quota footer lines` limits how many quota lines are shown (1-3); it never changes which
  periods the API returns.
- `Team seats` stores a comma-separated, case-insensitive substring filter, so `team`
  matches `team-a`. A filter matching nothing falls back to every seat instead of blanking
  the footer.
