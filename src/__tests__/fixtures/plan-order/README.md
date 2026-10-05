# planOrder byte-for-byte fixture (CC-628)

Every task and initiative here is invented. Twenty open tasks across four initiatives (`north`,
`south`, `east`, `west`) with no planning tags. Under the test's share caps (product 0.2, docs 0.1,
nit 0.1) the top 10 hits caps, and three tasks wait on another open task in prose, so
`dispatchOrder` drops them. `burndown-plan-order.test.ts` checks that `planOrder` returns the same
order and refusals, serialized, as `dispatchOrder` over this backlog.
