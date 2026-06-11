---
title: Vessel emission analytics
description: How to fetch and render a vessel's year-to-date CII analytics.
mode: ambient
---

# Vessel emission analytics

When the user asks about a vessel's **CII** (Carbon Intensity Indicator), emission
analytics, or carbon-rating trend:

1. Call **`westship_get_emission_analytics`** with the vessel identifier and the
   reporting year. It returns the analytics already shaped for the chart.
2. Pass that result **straight** to **`show_emission_analytics`** to render the
   widget — do not reshape or summarise the numbers yourself; the data is already
   in the exact shape the widget expects.

The `westship_get_emission_analytics` response includes the attained CII curve(s),
the A–E rating boundaries per year, and a correction-factors summary.
