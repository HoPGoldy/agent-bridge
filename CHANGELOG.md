# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.7.1](https://github.com/HoPGoldy/agent-bridge/compare/v0.7.0...v0.7.1) (2026-08-15)


### Features

* resolve and remember /new working directories on the client side ([cf12b0f](https://github.com/HoPGoldy/agent-bridge/commit/cf12b0f70040a630bf1fa2078d428f615fb5d54a))

## [0.7.0](https://github.com/HoPGoldy/agent-bridge/compare/v0.6.0...v0.7.0) (2026-08-13)


### Features

* add scoped agent session state API ([021664f](https://github.com/HoPGoldy/agent-bridge/commit/021664fcb825e7dd419fe690ccb916c0a04dbf34))
* parse working directory for new sessions ([00ff022](https://github.com/HoPGoldy/agent-bridge/commit/00ff0229b9bca6dee55f788f772e7eae94211c09))
* persist session working directories ([5ee3851](https://github.com/HoPGoldy/agent-bridge/commit/5ee3851b6dfbd2380e642186cc3a9992a1a73a86))
* restrict session working directories ([2f2c105](https://github.com/HoPGoldy/agent-bridge/commit/2f2c1051ea92f7dac6e930cfc03877169e6391d4))
* scope opencode sessions to requested directories ([5068c87](https://github.com/HoPGoldy/agent-bridge/commit/5068c87ccc75029fa0928c05aa1989189b36f362))
* share media delivery with OpenCode ([847333c](https://github.com/HoPGoldy/agent-bridge/commit/847333c652dedb327c7b94c89a2aecd4eea67619))
* start pi sessions in requested directories ([d2ad829](https://github.com/HoPGoldy/agent-bridge/commit/d2ad829f884b75bb8fbfb6754a18e7a495a0fa82))


### Bug Fixes

* harden session shutdown and restore errors ([c523ef4](https://github.com/HoPGoldy/agent-bridge/commit/c523ef4b0a786422adfa5fbcbec988861b164f7f))
* restore clean TypeScript checks ([a45546c](https://github.com/HoPGoldy/agent-bridge/commit/a45546c29b34c63447f9ae11b18ead1abefd8739))

## [0.6.0](https://github.com/HoPGoldy/agent-bridge/compare/v0.4.2...v0.6.0) (2026-08-02)


### Features

* add OpenCode agent adapter ([e89f86f](https://github.com/HoPGoldy/agent-bridge/commit/e89f86fc1f34f588158e56edb099047e895821df))
* add OpenCode agent adapter ([f60dba7](https://github.com/HoPGoldy/agent-bridge/commit/f60dba75b8c20094c9e14a2fd9443568fdca47a3))

## [0.4.2](https://github.com/HoPGoldy/agent-bridge/compare/v0.4.1...v0.4.2) (2026-07-26)


### Bug Fixes

* compact error detail markdown ([8dcaac2](https://github.com/HoPGoldy/agent-bridge/commit/8dcaac2a2f9b7338bde2d28aeacdeeb258e5c105))

## [0.4.1](https://github.com/HoPGoldy/agent-bridge/compare/v0.4.0...v0.4.1) (2026-07-26)


### Features

* clarify Pi model configuration ([1a6a8a4](https://github.com/HoPGoldy/agent-bridge/commit/1a6a8a420927132961f6373d5439574c78e8aece))


### Bug Fixes

* preserve command response cleanup with run failures ([d693413](https://github.com/HoPGoldy/agent-bridge/commit/d693413007bc00417e8e7bcd80abf4df39abbb17))
* steer messages during active agent runs ([7c7535a](https://github.com/HoPGoldy/agent-bridge/commit/7c7535a04f8443818c2d280101b47d81bbd6d775))
* surface terminal agent run failures ([eed0b07](https://github.com/HoPGoldy/agent-bridge/commit/eed0b0756e87fa205cfb6ef7fa494eb048cb8a6c))

## [0.4.0](https://github.com/HoPGoldy/agent-bridge/compare/v0.3.4...v0.4.0) (2026-07-25)


### Features

* add session model slash commands ([b8d651e](https://github.com/HoPGoldy/agent-bridge/commit/b8d651efb49354ffdd11107dfd83e81f0ed88cf8))
* add structured session status command ([0f32e9b](https://github.com/HoPGoldy/agent-bridge/commit/0f32e9b81b3f0914f46068298118a4ca2f8da714))


### Bug Fixes

* unify IM command response lifecycle ([c885f75](https://github.com/HoPGoldy/agent-bridge/commit/c885f75e00f6fd4a6333b76f741533a3b21b8bbf))

## [0.3.4](https://github.com/HoPGoldy/agent-bridge/compare/v0.3.3...v0.3.4) (2026-07-24)


### Bug Fixes

* sync pnpm lockfile ([ec32cdb](https://github.com/HoPGoldy/agent-bridge/commit/ec32cdb8fac8422997dec382213073821837a4ad))

## [0.3.3](https://github.com/HoPGoldy/agent-bridge/compare/v0.3.2...v0.3.3) (2026-07-24)


### Bug Fixes

* read cli version from package metadata ([78448a8](https://github.com/HoPGoldy/agent-bridge/commit/78448a8ef7c8947f1dfe72961efcb8c19de66189))

## [0.3.2](https://github.com/HoPGoldy/agent-bridge/compare/v0.3.1...v0.3.2) (2026-07-24)


### Features

* add /s slash command alias ([43aa24c](https://github.com/HoPGoldy/agent-bridge/commit/43aa24c9ab7ccc289066b21d71d1d6de2ae692fb))
* add channel language i18n support ([9555c6e](https://github.com/HoPGoldy/agent-bridge/commit/9555c6eb3a412f97fd8fc06a838a3122c84813a8))
* add localized /help slash command ([6d7a7ae](https://github.com/HoPGoldy/agent-bridge/commit/6d7a7ae4f103cbb0a253c690a41a604ec3e2e796))


### Bug Fixes

* avoid redundant generic tool error text ([e291fce](https://github.com/HoPGoldy/agent-bridge/commit/e291fcef74c692e294b198a6135ec48257e63cfa))

## [0.3.1](https://github.com/HoPGoldy/agent-bridge/compare/v0.2.1...v0.3.1) (2026-07-23)


### Features

* add slash command aliases ([4d2491e](https://github.com/HoPGoldy/agent-bridge/commit/4d2491e7b22332b33efb438affd226955a7681c5))
* enrich tool progress events ([11200e3](https://github.com/HoPGoldy/agent-bridge/commit/11200e3e7d0f2c87ac34e7878bf80f432cd87cc1))


### Bug Fixes

* keep tool progress order stable ([22a7308](https://github.com/HoPGoldy/agent-bridge/commit/22a73088980f6ce0894f5732223c71a98eaffcaf))

## [0.3.0](https://github.com/HoPGoldy/agent-bridge/compare/v0.2.1...v0.3.0) (2026-07-23)


### Features

* add slash command aliases ([4d2491e](https://github.com/HoPGoldy/agent-bridge/commit/4d2491e7b22332b33efb438affd226955a7681c5))
* enrich tool progress events ([11200e3](https://github.com/HoPGoldy/agent-bridge/commit/11200e3e7d0f2c87ac34e7878bf80f432cd87cc1))

## [0.2.1](https://github.com/HoPGoldy/agent-bridge/compare/v0.2.0...v0.2.1) (2026-07-23)


### Bug Fixes

* **ci:** pin pnpm via packageManager and switch CI workflow to pnpm ([44ac5d6](https://github.com/HoPGoldy/agent-bridge/commit/44ac5d6fbe91ec610f1bd0044b8aea1cc9c4de21))

## [0.2.0](https://github.com/HoPGoldy/agent-bridge/compare/v0.1.2...v0.2.0) (2026-07-23)

## [0.1.2](https://github.com/HoPGoldy/agent-bridge/compare/v0.1.1...v0.1.2) (2026-07-23)


### Features

* add wecom client adapter ([b78e46f](https://github.com/HoPGoldy/agent-bridge/commit/b78e46f1ce9ead0169caa718b629a28d6e421dc1))


### Bug Fixes

* forward pi assistant message_end text ([563f3eb](https://github.com/HoPGoldy/agent-bridge/commit/563f3ebf5df64bdf3a143ccd92cb29f3b370d9cb))
* ignore empty pi assistant message_end ([f333886](https://github.com/HoPGoldy/agent-bridge/commit/f3338860cac74fbedc4456e6d736e58b32f7ea65))
* rename generic CLI description from IM to Pi bridge to IM to Agent bridge ([af6e99b](https://github.com/HoPGoldy/agent-bridge/commit/af6e99b76276ad51ce0564b773c91da1e566b651))
* **types:** resolve ChannelConfig union assignment and add qrcode-terminal types ([2985ec6](https://github.com/HoPGoldy/agent-bridge/commit/2985ec60fef9589a7109486cdf8e0a34dcc6731c))
* **wecom:** use sdk stream replies for progress ([b316c19](https://github.com/HoPGoldy/agent-bridge/commit/b316c19fee5b7fefe66af1f6273e7ef36a3aba65))

## 0.1.1 (2026-07-22)


### Features

* add agent progress events ([98ff94e](https://github.com/HoPGoldy/agent-bridge/commit/98ff94e95e2864d5b173cdb833b512ce68250dcf))
* bidirectional image/file attachment transfer for Feishu ([487edc8](https://github.com/HoPGoldy/agent-bridge/commit/487edc85594e4c77a96f12bec5516b42d5ab4788))
* improve Feishu progress cards and core tool logging ([2ad1763](https://github.com/HoPGoldy/agent-bridge/commit/2ad17632002bf587bdcb468b21ff63806cf73708))
* replace progress command with stop ([9ec8b9e](https://github.com/HoPGoldy/agent-bridge/commit/9ec8b9e57d2d2891c8af4066d14b2fb3d40de53f))
* use NODE_ENV for media prompt path ([f83e4c3](https://github.com/HoPGoldy/agent-bridge/commit/f83e4c3957447ff065b4a67747d8c88323b529ab))


### Bug Fixes

* **feishu:** improve reactions markdown and delivery errors ([a470c05](https://github.com/HoPGoldy/agent-bridge/commit/a470c05c6e41d4a4f5a6348c452480a8b3b8ca8f))
