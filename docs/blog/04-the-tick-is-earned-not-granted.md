# The ✓ is earned, not granted

*D17 blog · 04 · verification*

Every marketplace eventually invents a badge. A blue tick, a "verified" label, an audited stamp — and with it, a committee. Someone decides who gets the badge, and the badge quietly becomes a measure of who knows the committee.

D17 has mechanical verification checks. No one grants them by discretion.

## How it works

When a creator deploys a launch, the token metadata is hashed and recorded by the token, launch, and factory event. The terminal's **✓ VERIFIED** metadata mark appears only when the name, symbol, description, image, links, stored hashes, factory event, and token `contractURI` agree.

The economic rules have a separate hash. It covers every number that decides what you get and what you pay: schedule, round shares, minimums, refund penalty, treasury fee and address, **protocol fee and its recipient**, supply split, creator allocation. Before a commitment, the locker checks the D17 launch identity, WETH address, canonical factory registration, and that exact rules hash. The terminal exposes that as **Check rules**.

Neither check has an application form, review queue, or judgment call. They are consistency statements, not endorsements.

## What it protects you from

The subtle scam in token launches isn't usually the code — it's the **gap between the pitch and the deployment**. The site says 5% team allocation; the contract says 10%. The announcement says a 1% fee; the contract takes 2%. Nobody reads the bytecode, everybody reads the landing page, and the gap is where trust dies.

The metadata check makes identity drift visible. The locker rules check prevents a call through that locker from treating an imitation contract — or a launch with different terms — as the canonical D17 launch you checked. Because the fees are inside the rules hash, a launch's fees can't silently differ from what you verified, and they can't change after you commit. A malicious frontend can still propose an unrelated wallet transaction, which is why the wallet's destination and transaction details remain important.

## What it deliberately doesn't promise

Honesty about the badge requires saying what it isn't:

- It is **not** an endorsement. A verified launch can still be a bad idea.
- It says nothing about the **token's value**, the team's competence, or whether the project will exist next spring.
- It doesn't replace an audit of the underlying contract suite.
- The metadata tick does not, by itself, verify every economic parameter. Use the separate locker rules check.

"Verified" should therefore be read narrowly: *these on-chain records agree*. That is useful evidence, but it is not a promise about price, intent, or safety.

Trust, minimized: not "trust us," not even "trust the reviewers" — just check the hash.

---

*The mechanics: the metadata badge checks token/launch/event/contract-URI consistency; `rulesHash()` separately commits to the full launch configuration including `protocolFeeBps` and `protocolFeeRecipient`; lockers verify version identity, WETH, canonical registration, and the supplied rules hash before commitment and settlement-sensitive paths.*
