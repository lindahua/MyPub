# Author profile review — batch 1

Reviewed 27 September 2026 against the linked publication UUIDs, cached public ORCID records, publisher DOI metadata, and selected author pages. These decisions concern individual ORCID candidates, not a finding that an author has no ORCID. The accepted cases have catalog identity reviews; the other decisions below remain in this queue for future passes.

## Accepted

| Catalog author | ORCID | Match evidence |
| --- | --- | --- |
| `duan_haodong` | [0000-0002-3052-4177](https://orcid.org/0000-0002-3052-4177) | Public ORCID record lists exact arXiv IDs for [Revisiting Skeleton-based Action Recognition](https://arxiv.org/abs/2104.13586) and [Omni-sourced Webly-supervised Learning for Video Recognition](https://arxiv.org/abs/2003.13042); [author homepage](https://kennymckormick.github.io/) lists the former with matching coauthors. |
| `sun_zeyi` | [0009-0008-4264-4281](https://orcid.org/0009-0008-4264-4281) | Public ORCID record lists exact arXiv DOIs for [Alpha-CLIP](https://arxiv.org/abs/2312.03818), [GPT4Point](https://arxiv.org/abs/2312.02980), and [Gemini vs GPT-4V](https://arxiv.org/abs/2312.15011), all linked to this author UUID. |
| `zhou_hang` | [0000-0002-2616-923X](https://orcid.org/0000-0002-2616-923X) | Public ORCID record lists exact arXiv IDs for [A Graph-Based Framework to Bridge Movies and Synopses](https://arxiv.org/abs/1910.11009), [Sep-Stereo](https://arxiv.org/abs/2007.09902), and [Visually Informed Binaural Audio Generation](https://arxiv.org/abs/2104.06162). |
| `zhang_wenwei` | [0000-0002-2748-4514](https://orcid.org/0000-0002-2748-4514) | Public ORCID record lists exact arXiv IDs for [Side-Aware Boundary Localization](https://arxiv.org/abs/1912.04260) and [Seesaw Loss](https://arxiv.org/abs/2008.10032); [author homepage](https://zhangwenwei.cn/) confirms his MMDetection research history. |

The ORCID records were retrieved through the [ORCID public API](https://pub.orcid.org/v3.0/0000-0002-3052-4177/record) and retained in `local/author-profiles/orcid/`. `local/author-profiles/orcid-review-batch-1.json` contains the exact DOI/UUID match inputs used by `scripts/apply-reviewed-author-orcids.mjs`.

## Rejected candidate

| Catalog author | Candidate | Decision |
| --- | --- | --- |
| `wang_wenhai` | [0000-0002-8402-7504](https://orcid.org/0000-0002-8402-7504) | Reject. The public ORCID name is **Xiaogang Wang**, while the catalog credit is **Wenhai Wang**. The [publisher DOI record](https://doi.org/10.1109/tpami.2026.3702168) appears to attach the wrong ORCID to that byline. Do not reuse this candidate for Wenhai Wang. |

## Deferred candidates

| Catalog author | Candidate | Evidence gap or conflict |
| --- | --- | --- |
| `chen_kai` | [0000-0002-6820-2325](https://orcid.org/0000-0002-6820-2325) | Name and Shanghai AI Laboratory employment are compatible; the public ORCID record has no matching work for the single [VLMEvalKit publisher DOI](https://doi.org/10.1145/3664647.3685520). Common-name risk remains. |
| `zhang_pan` | [0000-0002-2539-8815](https://orcid.org/0000-0002-2539-8815), [0009-0004-7195-4159](https://orcid.org/0009-0004-7195-4159) | Publisher records assign two ORCIDs with the same name to [VLMEvalKit](https://doi.org/10.1145/3664647.3685520) and [HyperDreamer](https://doi.org/10.1145/3610548.3618168), respectively. Neither public ORCID record lists a matching work. Check whether the HyperDreamer credit is linked to the correct Pan Zhang identity before choosing either ID. |
| `guo_qipeng` | [0000-0002-8805-8789](https://orcid.org/0000-0002-8805-8789) | One exact publisher byline on [Origen](https://doi.org/10.1145/3676536.3676830), but the public ORCID record lists no matching work or other disambiguating evidence. |
| `wang_jingbo` | [0000-0001-9700-6262](https://orcid.org/0000-0001-9700-6262) | One publisher byline on [Motion Guided 3D Pose Estimation](https://doi.org/10.1007/978-3-030-58601-0_45); public ORCID record does not list that or another linked work. |
| `wang_wenhai` | [0000-0002-2418-3134](https://orcid.org/0000-0002-2418-3134) | Public name matches and one publisher byline on [bird's-eye-view perception](https://doi.org/10.1109/tpami.2023.3333838), but no public ORCID work corroborates this specific author UUID. Separate from the rejected Xiaogang Wang ID above. |
| `chen_lin` | [0000-0002-5935-3877](https://orcid.org/0000-0002-5935-3877) | One publisher byline on [VLMEvalKit](https://doi.org/10.1145/3664647.3685520); the public ORCID record has no matching work or other identity anchor. |
| `chen_xinyuan` | [0000-0002-5517-7255](https://orcid.org/0000-0002-5517-7255) | Public ORCID works do not overlap the catalog author's linked papers, despite one publisher byline on [VBench++](https://doi.org/10.1109/tpami.2025.3633890). Same-name risk is unresolved. |
| `zhang_yuqi` | [0000-0003-1883-4081](https://orcid.org/0000-0003-1883-4081) | Public ORCID record lists the exact arXiv ID for [Placepedia](https://arxiv.org/abs/2007.03777), but this is the only public work overlap. Seek an independent author-controlled or institutional identity link before assignment. |
| `huang_xuanjing` / `huang_xuan_jing` | [0000-0001-9197-9426](https://orcid.org/0000-0001-9197-9426) | The same ORCID record lists exact works linked to **both** catalog UUIDs under Xuanjing Huang and Xuan-Jing Huang. Resolve their identity relationship first; uniqueness rules forbid assigning the same ORCID to both, and this batch did not merge them. |

The deferred rows are live review tasks. A missing public ORCID work is inconclusive because public records can be incomplete. Do not convert these decisions into negative identity claims or assign the candidate based on a name match alone.

## Batch result

Four ORCIDs were attached, one candidate was rejected, and ten candidate IDs were deferred across nine review rows. The active catalog now has **137 authors with ORCID, 16 with Scholar, 15 with both, and 1,712 with neither**. No publication credits or author merges changed in this batch. Catalog validation passes with the same seven unresolved-author warnings noted in the enrichment plan.
