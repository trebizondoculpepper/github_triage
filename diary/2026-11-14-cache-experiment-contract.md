# Cache experiment contract

Started the shared docs prerequisite for #202/#203 after the quota incident increased safe-reuse importance. Defined isolated refresh and storage experiments, context/coverage envelope, live mutable-fact boundaries, 304 handling, failure/retention tests and point-cost measurements. No production cache, credentials, daemon, live probes or workflow mutations added. Review/merge remains the implementation gate.

CodeRabbit review found that the existing staleMs path can break a still-live lock. Clarified that the experiment disables age-only takeover, times out as a cache miss, and only cleans disposable roots after all possible holders are stopped; injected tests must cover a slow live holder and crashed-holder recovery. No production lock code changed.
