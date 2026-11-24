import ./textmetrics

const FontMetricsJson* = staticRead("../../server/font-metrics.json")

proc loadEmbeddedMetrics*(): int = loadMetricsFromText(FontMetricsJson)
