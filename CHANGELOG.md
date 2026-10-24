# Changelog

## [1.4.0](https://github.com/devbydaniel/vitals/compare/vitals-v1.3.0...vitals-v1.4.0) (2026-10-24)


### Features

* trend views (value, 30d, 90d per metric; nights by the day before) and fix duplicate daily documents ([#7](https://github.com/devbydaniel/vitals/issues/7)) ([9200dfc](https://github.com/devbydaniel/vitals/commit/9200dfc275a8bb887f2b06059e71db95ead9554c))

## [1.3.0](https://github.com/devbydaniel/vitals/compare/vitals-v1.2.0...vitals-v1.3.0) (2026-10-24)


### Features

* day log tables and tracker role for daily context (office, own bed, meetings, coffee, drinks, people met) ([#5](https://github.com/devbydaniel/vitals/issues/5)) ([7c0bd14](https://github.com/devbydaniel/vitals/commit/7c0bd145c718f3f1e2950b5e7206a1805d0716f7))

## [1.2.0](https://github.com/devbydaniel/vitals/compare/vitals-v1.1.0...vitals-v1.2.0) (2026-07-19)


### Features

* training views — HR trends with rolling means, daily HR zones, workout log ([3fa1438](https://github.com/devbydaniel/vitals/commit/3fa143844a2789ee8824ee228a9dbc8f959edc6c))

## [1.1.0](https://github.com/devbydaniel/vitals/compare/vitals-v1.0.1...vitals-v1.1.0) (2026-07-19)


### Features

* reuse access token until near expiry — sparse refresh rotations for hourly sync (VIT-12) ([81dc97c](https://github.com/devbydaniel/vitals/commit/81dc97c6c4cfb1dafeb5328c48f98965ab893379))

## [1.0.1](https://github.com/devbydaniel/vitals/compare/vitals-v1.0.0...vitals-v1.0.1) (2026-07-18)


### Bug Fixes

* batch heartrate upserts below wire-protocol param limit (VIT-11) ([270e507](https://github.com/devbydaniel/vitals/commit/270e507e8d7d77d056d603e90c8c1a03cb03f264))
* use extapi scope names required by new-portal oauth apps (VIT-10) ([bee4ed7](https://github.com/devbydaniel/vitals/commit/bee4ed7e99f0748ec1340af37d1aa48ab6c92a2c))

## 1.0.0 (2026-07-18)


### Features

* auth CLI, sync engine, and interpretation-layer SQL views (VIT-4, VIT-5, VIT-6) ([d02a6bf](https://github.com/devbydaniel/vitals/commit/d02a6bf5fcb66c6df41aab5cd7cbf39912028ecc))
* data layer and oura client with rotating token machinery (VIT-2, VIT-3) ([831733d](https://github.com/devbydaniel/vitals/commit/831733d6cb247105e0c5a33a032abd94179162eb))
* production image and release CI publishing to ghcr (VIT-7) ([127ac22](https://github.com/devbydaniel/vitals/commit/127ac225457fc24d149eea7193003bae5b07903a))
