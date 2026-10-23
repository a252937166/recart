# Fixture specification sheet (fixture-catalog-v1)

Every product below is a team-authored, brand-free simulation for the ReCart demo. The facts are the fixture's declared properties; they are not claims about any physical product. Each fact in `src/domain/catalog/fixtures.ts` cites its row here as `spec-sheet-v1#SKU`. This page is generated from that file.

Evidence modes: **FIXTURE** means declared by this sheet; **UNKNOWN** means deliberately undocumented, so any check that depends on it cannot pass.

| SKU | Product | Role | Price | Declared facts |
|---|---|---|---|---|
| <a id="MIC-DX-A"></a>MIC-DX-A | Dynamic XLR Mic A | mic | $49.00 | output: xlr; needsPhantom: false |
| <a id="MIC-DX-B"></a>MIC-DX-B | Dynamic XLR Mic B | mic | $69.00 | output: xlr; needsPhantom: false |
| <a id="MIC-CX-C"></a>MIC-CX-C | Condenser XLR Mic C | mic | $59.00 | output: xlr; needsPhantom: true |
| <a id="MIC-USB-D"></a>MIC-USB-D | USB-C Mic D | mic | $79.00 | output: usb-c; needsPhantom: false; monitorJack: true |
| <a id="IF-2C-LB"></a>IF-2C-LB | 2-in USB-C Interface with Loopback | interface | $129.00 | preamps: 2; phantom: true; headphoneOuts: 2; hostPort: usb-c; loopback: true; os: macos, windows |
| <a id="IF-2C-NL"></a>IF-2C-NL | 2-in USB-C Interface (no loopback) | interface | $99.00 | preamps: 2; phantom: true; headphoneOuts: 2; hostPort: usb-c; loopback: false; os: macos, windows |
| <a id="IF-2B-LB"></a>IF-2B-LB | 2-in USB-B Interface with Loopback | interface | $159.00 | preamps: 2; phantom: true; headphoneOuts: 2; hostPort: usb-b; loopback: true; os: macos, windows |
| <a id="IF-4C-LB"></a>IF-4C-LB | 4-in USB-C Interface with Loopback | interface | $249.00 | preamps: 4; phantom: true; headphoneOuts: 2; hostPort: usb-c; loopback: true; os: macos, windows |
| <a id="IF-2C-UK"></a>IF-2C-UK | 2-in USB-C Interface (routing unverified) | interface | $119.00 | preamps: 2; phantom: true; headphoneOuts: 2; hostPort: usb-c; loopback: not documented (UNKNOWN); os: macos, windows |
| <a id="HP-CB-A"></a>HP-CB-A | Closed-back Headphones A | headphones | $29.00 | type: closed |
| <a id="HP-OB-B"></a>HP-OB-B | Open-back Headphones B | headphones | $45.00 | type: open |
| <a id="CBL-XLR-3"></a>CBL-XLR-3 | XLR Cable 3 m | micCable | $12.00 | ends: xlr, xlr |
| <a id="CBL-CC-1"></a>CBL-CC-1 | USB-C to USB-C Cable 1 m | hostCable | $10.00 | deviceEnd: usb-c; hostEnd: usb-c |
| <a id="CBL-BA-1"></a>CBL-BA-1 | USB-B to USB-A Cable 1 m | hostCable | $10.00 | deviceEnd: usb-b; hostEnd: usb-a |
| <a id="ADP-AC"></a>ADP-AC | USB-A to USB-C Host Adapter | adapter | $12.00 | from: usb-a; to: usb-c |
| <a id="STD-DK-A"></a>STD-DK-A | Desk Mic Stand | stand | $15.00 | type: desk |
| <a id="STD-BM-B"></a>STD-BM-B | Desk Boom Arm | stand | $25.00 | type: boom |
| <a id="SPL-HP-2"></a>SPL-HP-2 | Headphone Splitter (2-way) | splitter | $9.00 | outputs: 2 |

## Recipes (fixture-recipes-v1)

### R-LOCAL2-REMOTE1: In-room hosts plus one remote guest

Up to two people in the room on XLR mics, plus one remote guest joining through a call app using interface loopback routing.

Supported OS: macos, windows. Remote routing: Interface loopback sends the room mics into the call app; the call audio returns on the interface headphone outputs. Declared call apps: zoom, google-meet.

| Role | Allowed products | Kind |
|---|---|---|
| Microphones | MIC-CX-C, MIC-DX-A, MIC-DX-B | exact |
| Audio interface | IF-2B-LB, IF-2C-LB, IF-2C-NL, IF-2C-UK, IF-4C-LB | exact |
| Headphones | HP-CB-A, HP-OB-B | exact |
| Microphone cables | CBL-XLR-3 | exact |
| Computer cable | CBL-BA-1, CBL-CC-1 | exact |
| Host adapter | ADP-AC | optional |
| Stands | STD-BM-B, STD-DK-A | exact |
| Headphone splitter | SPL-HP-2 | optional |

Excluded: More than two people in the room; More than one remote guest; Linux or call apps outside the declared list.

### R-LOCAL-2: In-room recording, no remote guest

One or two people recording in the same room on XLR mics.

Supported OS: macos, windows.

| Role | Allowed products | Kind |
|---|---|---|
| Microphones | MIC-CX-C, MIC-DX-A, MIC-DX-B | exact |
| Audio interface | IF-2B-LB, IF-2C-LB, IF-2C-NL, IF-2C-UK, IF-4C-LB | exact |
| Headphones | HP-CB-A, HP-OB-B | exact |
| Microphone cables | CBL-XLR-3 | exact |
| Computer cable | CBL-BA-1, CBL-CC-1 | exact |
| Host adapter | ADP-AC | optional |
| Stands | STD-BM-B, STD-DK-A | exact |
| Headphone splitter | SPL-HP-2 | optional |

Excluded: Remote guests; More than two people in the room; Linux.

### R-SOLO-REMOTE: One-person remote interview

A single host on a USB-C mic with its monitor jack, interviewing at most one remote guest.

Supported OS: macos, windows. Remote routing: The USB mic is selected directly as the call app microphone; call audio plays through the mic's monitor jack. Declared call apps: zoom, google-meet.

| Role | Allowed products | Kind |
|---|---|---|
| Microphone | MIC-USB-D | exact |
| Headphones | HP-CB-A, HP-OB-B | exact |
| Stand | STD-BM-B, STD-DK-A | exact |

Excluded: More than one person in the room; USB-A-only computers.

## Demo scenario stock

| SKU | A | B | C |
|---|---|---|---|
| MIC-DX-A | 4 | 4 | 4 |
| MIC-DX-B | 3 | 3 | 3 |
| MIC-CX-C | 3 | 3 | 3 |
| MIC-USB-D | 2 | 2 | 2 |
| IF-2C-LB | 1 | 1 | 1 |
| IF-2C-NL | 3 | 3 | 3 |
| IF-2B-LB | 2 | 2 | 0 |
| IF-4C-LB | 1 | 1 | 0 |
| IF-2C-UK | 0 | 0 | 0 |
| HP-CB-A | 6 | 6 | 6 |
| HP-OB-B | 2 | 2 | 2 |
| CBL-XLR-3 | 10 | 10 | 10 |
| CBL-CC-1 | 5 | 5 | 5 |
| CBL-BA-1 | 5 | 5 | 5 |
| ADP-AC | 4 | 4 | 4 |
| STD-DK-A | 6 | 6 | 6 |
| STD-BM-B | 2 | 2 | 2 |
| SPL-HP-2 | 3 | 3 | 3 |

Tax is a fixture rule: 8% of the subtotal, rounded half up to the cent. Pickup is at a simulated store counter in two-hour slots starting at 10 am, 12 pm, 2 pm, 4 pm and 6 pm Pacific, with a two-hour lead time (pickup-policy-v1).
