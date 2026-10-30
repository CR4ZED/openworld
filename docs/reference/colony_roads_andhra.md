# Reference: colony roads in coastal Andhra Pradesh

Construction reference for modelling roads in 3D. This describes how such roads are typically built.
It is **not** data about any specific street: per-street width, surface, drains and edges come only
from the owner's survey (see CLAUDE.md realism rules).

## Owner's observation (2026-10-30)

Most roads in and around FCI Colony are **concrete (CC)** or **red mud (moram)**.

## Cement concrete (CC) colony/village roads

Source: Government of Andhra Pradesh, PR&RD Dept., technical guidelines for CC roads with side drains
under MGNREGS (2015): https://etcsrikalahasti.ap.gov.in/assets/PDF/CC_Roads_tecnical_2015PR_MS91.pdf

- Built over a granular (gravel) or WBM sub-base.
- Key walls 0.23 m wide along both edges; 3.0 m outer-to-outer under MGNREGS, 2.54 m between key walls.
  Wider roads are designed per IRC:SP:62-2014.
- Concrete slab about 125 mm thick (M30). Side drains are part of the scheme, but whether a given street
  has them is a survey question.
- Visual cues for modelling: flat grey slab, transverse construction joints, crumbling or chipped edges,
  slab sitting slightly above the surrounding ground.

## Red mud / moram roads and shoulders

- Moram (moorum) is a local lateritic red gravelly soil used for unpaved roads, sub-bases and berms
  (shoulders) beside CC slabs. See IRC:SP:77-2008, Manual for gravel roads:
  https://law.resource.org/pub/in/bis/irc/irc.gov.in.sp.077.2008.pdf
- Visual cues: reddish-brown, loose gravel on top, ruts, puddles and water-logging after rain.

## How the game uses this

- Surveyed streets: drawn exactly as surveyed.
- Unsurveyed streets: shown in the 3D view with a clearly marked "unsurveyed" look based on the owner's
  area note, never with an invented width or drain.
