// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giles Hall

//! Network pieces over row-major (T, C) frame matrices.

use crate::weights::{err, Result, Weights};

/// y = x W^T + b. W is packed in panels of CB outputs: panel p holds (cin, CB) contiguous, so the
/// kernel streams it once per tile of RB rows. An int8 Linear quantizes each row of x on the fly
/// and holds W as int8 with a scale per output.
pub struct Linear {
    pub cin: usize,
    pub cout: usize,
    panels: Vec<f32>,
    qpanels: Vec<i8>,
    wscale: Vec<f32>,
    b: Vec<f32>,
}

const RB: usize = 6; // rows per tile
const CB: usize = 16; // outputs per panel
const XP: usize = 8; // packed x stride: RB rows, padded
/// A packed int8 row's bytes for each group of four inputs: the four, or for wasm's widening
/// multiplies (quad) inputs 0 and 1 four times, then 2 and 3 four times.
#[cfg(target_arch = "wasm32")]
const XG: usize = 16;
#[cfg(not(target_arch = "wasm32"))]
const XG: usize = 4;

/// acc = bias + xp^T panel for one RB x CB tile; xp is (cin, XP), panel (cin, CB).
#[cfg(target_arch = "aarch64")]
#[inline(always)]
fn tile(xp: &[f32], panel: &[f32], cin: usize, bias: &[f32; CB], acc: &mut [[f32; CB]; RB]) {
    use std::arch::aarch64::*;
    assert!(xp.len() >= cin * XP && panel.len() >= cin * CB);
    // SAFETY: every load stays inside xp and panel (checked above); stores go to acc.
    unsafe {
        let bp = bias.as_ptr();
        let b = [vld1q_f32(bp), vld1q_f32(bp.add(4)), vld1q_f32(bp.add(8)), vld1q_f32(bp.add(12))];
        let mut a = [b; RB];
        let mut px = xp.as_ptr();
        let mut pw = panel.as_ptr();
        for _ in 0..cin {
            let w = [vld1q_f32(pw), vld1q_f32(pw.add(4)), vld1q_f32(pw.add(8)), vld1q_f32(pw.add(12))];
            let xa = vld1q_f32(px);
            let xb = vld1q_f32(px.add(4));
            macro_rules! row {
                ($r:expr, $x:expr, $l:expr) => {
                    a[$r][0] = vfmaq_laneq_f32::<$l>(a[$r][0], w[0], $x);
                    a[$r][1] = vfmaq_laneq_f32::<$l>(a[$r][1], w[1], $x);
                    a[$r][2] = vfmaq_laneq_f32::<$l>(a[$r][2], w[2], $x);
                    a[$r][3] = vfmaq_laneq_f32::<$l>(a[$r][3], w[3], $x);
                };
            }
            row!(0, xa, 0);
            row!(1, xa, 1);
            row!(2, xa, 2);
            row!(3, xa, 3);
            row!(4, xb, 0);
            row!(5, xb, 1);
            px = px.add(XP);
            pw = pw.add(CB);
        }
        for r in 0..RB {
            for j in 0..4 {
                vst1q_f32(acc[r].as_mut_ptr().add(4 * j), a[r][j]);
            }
        }
    }
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "wasm32")))]
#[inline(always)]
fn tile(xp: &[f32], panel: &[f32], cin: usize, bias: &[f32; CB], acc: &mut [[f32; CB]; RB]) {
    *acc = [*bias; RB];
    for i in 0..cin {
        let w: &[f32; CB] = panel[i * CB..(i + 1) * CB].try_into().unwrap();
        for r in 0..RB {
            let xv = xp[i * XP + r];
            for c in 0..CB {
                acc[r][c] = xv.mul_add(w[c], acc[r][c]);
            }
        }
    }
}

/// acc = xp^T panel for one RB x CB tile in int8: xp is (kg, XP, 4), panel (kg, CB, 4), both
/// grouped by four inputs for SDOT; all RB rows, however many are wanted.
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "dotprod")]
unsafe fn tile_i8(xp: &[i8], panel: &[i8], kg: usize, _rn: usize, acc: &mut [[i32; CB]; RB]) {
    assert!(kg > 0 && xp.len() >= kg * XP * 4 && panel.len() >= kg * CB * 4);
    // SAFETY: the loop reads kg groups from each buffer (checked above) and writes acc's 96 i32s.
    std::arch::asm!(
            "movi v0.4s, #0",
            "movi v1.4s, #0",
            "movi v2.4s, #0",
            "movi v3.4s, #0",
            "movi v4.4s, #0",
            "movi v5.4s, #0",
            "movi v6.4s, #0",
            "movi v7.4s, #0",
            "movi v8.4s, #0",
            "movi v9.4s, #0",
            "movi v10.4s, #0",
            "movi v11.4s, #0",
            "movi v12.4s, #0",
            "movi v13.4s, #0",
            "movi v14.4s, #0",
            "movi v15.4s, #0",
            "movi v16.4s, #0",
            "movi v17.4s, #0",
            "movi v18.4s, #0",
            "movi v19.4s, #0",
            "movi v20.4s, #0",
            "movi v21.4s, #0",
            "movi v22.4s, #0",
            "movi v23.4s, #0",
            "2:",
            "ld1 {{v24.16b, v25.16b, v26.16b, v27.16b}}, [{w}], #64",
            "ld1 {{v28.16b, v29.16b}}, [{x}], #32",
            "sdot v0.4s, v24.16b, v28.4b[0]",
            "sdot v1.4s, v25.16b, v28.4b[0]",
            "sdot v2.4s, v26.16b, v28.4b[0]",
            "sdot v3.4s, v27.16b, v28.4b[0]",
            "sdot v4.4s, v24.16b, v28.4b[1]",
            "sdot v5.4s, v25.16b, v28.4b[1]",
            "sdot v6.4s, v26.16b, v28.4b[1]",
            "sdot v7.4s, v27.16b, v28.4b[1]",
            "sdot v8.4s, v24.16b, v28.4b[2]",
            "sdot v9.4s, v25.16b, v28.4b[2]",
            "sdot v10.4s, v26.16b, v28.4b[2]",
            "sdot v11.4s, v27.16b, v28.4b[2]",
            "sdot v12.4s, v24.16b, v28.4b[3]",
            "sdot v13.4s, v25.16b, v28.4b[3]",
            "sdot v14.4s, v26.16b, v28.4b[3]",
            "sdot v15.4s, v27.16b, v28.4b[3]",
            "sdot v16.4s, v24.16b, v29.4b[0]",
            "sdot v17.4s, v25.16b, v29.4b[0]",
            "sdot v18.4s, v26.16b, v29.4b[0]",
            "sdot v19.4s, v27.16b, v29.4b[0]",
            "sdot v20.4s, v24.16b, v29.4b[1]",
            "sdot v21.4s, v25.16b, v29.4b[1]",
            "sdot v22.4s, v26.16b, v29.4b[1]",
            "sdot v23.4s, v27.16b, v29.4b[1]",
            "subs {n}, {n}, #1",
            "b.ne 2b",
            "st1 {{v0.4s, v1.4s, v2.4s, v3.4s}}, [{o}], #64",
            "st1 {{v4.4s, v5.4s, v6.4s, v7.4s}}, [{o}], #64",
            "st1 {{v8.4s, v9.4s, v10.4s, v11.4s}}, [{o}], #64",
            "st1 {{v12.4s, v13.4s, v14.4s, v15.4s}}, [{o}], #64",
            "st1 {{v16.4s, v17.4s, v18.4s, v19.4s}}, [{o}], #64",
            "st1 {{v20.4s, v21.4s, v22.4s, v23.4s}}, [{o}], #64",
        w = inout(reg) panel.as_ptr() => _,
        x = inout(reg) xp.as_ptr() => _,
        n = inout(reg) kg => _,
        o = inout(reg) acc.as_mut_ptr() => _,
        out("v0") _, out("v1") _, out("v2") _, out("v3") _, out("v4") _, out("v5") _, out("v6") _, out("v7") _, out("v8") _, out("v9") _, out("v10") _, out("v11") _, out("v12") _, out("v13") _, out("v14") _, out("v15") _, out("v16") _, out("v17") _, out("v18") _, out("v19") _, out("v20") _, out("v21") _, out("v22") _, out("v23") _, out("v24") _, out("v25") _, out("v26") _, out("v27") _, out("v28") _, out("v29") _,
        options(nostack)
    );
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "wasm32")))]
unsafe fn tile_i8(xp: &[i8], panel: &[i8], kg: usize, rn: usize, acc: &mut [[i32; CB]; RB]) {
    *acc = [[0; CB]; RB];
    for g in 0..kg {
        for r in 0..rn {
            for c in 0..CB {
                for k in 0..4 {
                    acc[r][c] += xp[(g * XP + r) * 4 + k] as i32 * panel[(g * CB + c) * 4 + k] as i32;
                }
            }
        }
    }
}

#[cfg(all(target_arch = "wasm32", not(target_feature = "simd128")))]
compile_error!("the engine on wasm32 needs simd128 (RUSTFLAGS=\"-C target-feature=+simd128\")");

/// tile in wasm SIMD: multiply then add (wasm has no fused multiply-add), three rows at a time
/// so the sums stay in registers.
#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn tile(xp: &[f32], panel: &[f32], cin: usize, bias: &[f32; CB], acc: &mut [[f32; CB]; RB]) {
    use std::arch::wasm32::*;
    assert!(xp.len() >= cin * XP && panel.len() >= cin * CB);
    // SAFETY: every load stays inside xp and panel (checked above); stores go to acc.
    unsafe {
        let bp = bias.as_ptr() as *const v128;
        let b = [v128_load(bp), v128_load(bp.add(1)), v128_load(bp.add(2)), v128_load(bp.add(3))];
        for r0 in (0..RB).step_by(3) {
            let mut a = [b; 3];
            let mut px = xp.as_ptr().add(r0);
            let mut pw = panel.as_ptr() as *const v128;
            for _ in 0..cin {
                let w = [v128_load(pw), v128_load(pw.add(1)), v128_load(pw.add(2)), v128_load(pw.add(3))];
                for r in 0..3 {
                    let xv = f32x4_splat(*px.add(r));
                    for j in 0..4 {
                        a[r][j] = f32x4_add(a[r][j], f32x4_mul(w[j], xv));
                    }
                }
                px = px.add(XP);
                pw = pw.add(4);
            }
            for r in 0..3 {
                for j in 0..4 {
                    v128_store(acc[r0 + r].as_mut_ptr().add(4 * j) as *mut v128, a[r][j]);
                }
            }
        }
    }
}

/// The sums of four outputs over a group of four inputs: w holds the outputs' inputs 0 and 1 in
/// its low half and 2 and 3 in its high half, x the row's inputs 0 and 1 four times then 2 and 3.
/// Each pair of products fits in i16 (both sides lie in -127..127).
#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn quad(w: std::arch::wasm32::v128, x: std::arch::wasm32::v128) -> std::arch::wasm32::v128 {
    use std::arch::wasm32::*;
    i32x4_extadd_pairwise_i16x8(i16x8_add(i16x8_extmul_low_i8x16(w, x), i16x8_extmul_high_i8x16(w, x)))
}

/// acc's first rn rows = xp^T panel in int8, xp (kg, XP, XG) and panel (kg, CB, 4) in quad's
/// order: two rows at a time sharing each weight load, then one.
#[cfg(target_arch = "wasm32")]
unsafe fn tile_i8(xp: &[i8], panel: &[i8], kg: usize, rn: usize, acc: &mut [[i32; CB]; RB]) {
    use std::arch::wasm32::*;
    assert!(rn <= RB && xp.len() >= kg * XP * XG && panel.len() >= kg * CB * 4);
    // SAFETY: the loops read kg groups from each buffer (checked above) and write acc's rows.
    let mut r0 = 0;
    while r0 + 2 <= rn {
        let mut a = [[i32x4_splat(0); 4]; 2];
        for g in 0..kg {
            let w = panel.as_ptr().add(g * CB * 4) as *const v128;
            let ws = [v128_load(w), v128_load(w.add(1)), v128_load(w.add(2)), v128_load(w.add(3))];
            let px = xp.as_ptr().add((g * XP + r0) * XG) as *const v128;
            for r in 0..2 {
                let x = v128_load(px.add(r));
                for j in 0..4 {
                    a[r][j] = i32x4_add(a[r][j], quad(ws[j], x));
                }
            }
        }
        for r in 0..2 {
            for j in 0..4 {
                v128_store(acc[r0 + r].as_mut_ptr().add(4 * j) as *mut v128, a[r][j]);
            }
        }
        r0 += 2;
    }
    if r0 < rn {
        let mut a = [i32x4_splat(0); 4];
        for g in 0..kg {
            let w = panel.as_ptr().add(g * CB * 4) as *const v128;
            let x = v128_load(xp.as_ptr().add((g * XP + r0) * XG) as *const v128);
            for j in 0..4 {
                a[j] = i32x4_add(a[j], quad(v128_load(w.add(j)), x));
            }
        }
        for j in 0..4 {
            v128_store(acc[r0].as_mut_ptr().add(4 * j) as *mut v128, a[j]);
        }
    }
}

/// acc = bias + x panel for one row and N panels: each sum in tile's order, so the same bits.
#[inline(always)]
fn row_tiles<const N: usize>(x: &[f32], panels: [&[f32]; N], bias: [&[f32]; N], acc: &mut [[f32; CB]; N]) {
    let cin = x.len();
    for p in 0..N {
        assert!(panels[p].len() >= cin * CB && bias[p].len() >= CB);
    }
    #[cfg(target_arch = "aarch64")]
    // SAFETY: loads stay inside x, the panels and the biases (checked above); stores go to acc.
    unsafe {
        use std::arch::aarch64::*;
        let mut a = [[vdupq_n_f32(0.0); 4]; N];
        for p in 0..N {
            for j in 0..4 {
                a[p][j] = vld1q_f32(bias[p].as_ptr().add(4 * j));
            }
        }
        for (i, &xv) in x.iter().enumerate() {
            for p in 0..N {
                let pw = panels[p].as_ptr().add(i * CB);
                for j in 0..4 {
                    a[p][j] = vfmaq_n_f32(a[p][j], vld1q_f32(pw.add(4 * j)), xv);
                }
            }
        }
        for p in 0..N {
            for j in 0..4 {
                vst1q_f32(acc[p].as_mut_ptr().add(4 * j), a[p][j]);
            }
        }
    }
    #[cfg(target_arch = "wasm32")]
    // SAFETY: loads stay inside x, the panels and the biases (checked above); stores go to acc.
    unsafe {
        use std::arch::wasm32::*;
        let mut a = [[f32x4_splat(0.0); 4]; N];
        for p in 0..N {
            for j in 0..4 {
                a[p][j] = v128_load(bias[p].as_ptr().add(4 * j) as *const v128);
            }
        }
        for (i, &xv) in x.iter().enumerate() {
            let xs = f32x4_splat(xv);
            for p in 0..N {
                let pw = panels[p].as_ptr().add(i * CB);
                for j in 0..4 {
                    a[p][j] = f32x4_add(a[p][j], f32x4_mul(v128_load(pw.add(4 * j) as *const v128), xs));
                }
            }
        }
        for p in 0..N {
            for j in 0..4 {
                v128_store(acc[p].as_mut_ptr().add(4 * j) as *mut v128, a[p][j]);
            }
        }
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "wasm32")))]
    for p in 0..N {
        acc[p].copy_from_slice(&bias[p][..CB]);
        for (i, &xv) in x.iter().enumerate() {
            for c in 0..CB {
                acc[p][c] = xv.mul_add(panels[p][i * CB + c], acc[p][c]);
            }
        }
    }
}

/// acc = x^T panel for one int8 row, x (kg, 4), panel (kg, CB, 4); kg even.
#[cfg(target_arch = "aarch64")]
#[target_feature(enable = "dotprod")]
unsafe fn row_tile_i8(x: &[i8], panel: &[i8], kg: usize, acc: &mut [i32; CB]) {
    assert!(kg > 0 && kg % 2 == 0 && x.len() >= kg * 4 && panel.len() >= kg * CB * 4);
    // SAFETY: the loop reads kg groups from each buffer (checked above) and writes acc's 16 i32s.
    std::arch::asm!(
            "movi v0.4s, #0",
            "movi v1.4s, #0",
            "movi v2.4s, #0",
            "movi v3.4s, #0",
            "movi v4.4s, #0",
            "movi v5.4s, #0",
            "movi v6.4s, #0",
            "movi v7.4s, #0",
            "2:",
            "ld1 {{v24.16b, v25.16b, v26.16b, v27.16b}}, [{w}], #64",
            "ld1 {{v16.16b, v17.16b, v18.16b, v19.16b}}, [{w}], #64",
            "ldr d28, [{x}], #8",
            "sdot v0.4s, v24.16b, v28.4b[0]",
            "sdot v1.4s, v25.16b, v28.4b[0]",
            "sdot v2.4s, v26.16b, v28.4b[0]",
            "sdot v3.4s, v27.16b, v28.4b[0]",
            "sdot v4.4s, v16.16b, v28.4b[1]",
            "sdot v5.4s, v17.16b, v28.4b[1]",
            "sdot v6.4s, v18.16b, v28.4b[1]",
            "sdot v7.4s, v19.16b, v28.4b[1]",
            "subs {n}, {n}, #2",
            "b.ne 2b",
            "add v0.4s, v0.4s, v4.4s",
            "add v1.4s, v1.4s, v5.4s",
            "add v2.4s, v2.4s, v6.4s",
            "add v3.4s, v3.4s, v7.4s",
            "st1 {{v0.4s, v1.4s, v2.4s, v3.4s}}, [{o}]",
        w = inout(reg) panel.as_ptr() => _,
        x = inout(reg) x.as_ptr() => _,
        n = inout(reg) kg => _,
        o = in(reg) acc.as_mut_ptr(),
        out("v0") _, out("v1") _, out("v2") _, out("v3") _, out("v4") _, out("v5") _, out("v6") _, out("v7") _, out("v16") _, out("v17") _, out("v18") _, out("v19") _, out("v24") _, out("v25") _, out("v26") _, out("v27") _, out("v28") _,
        options(nostack)
    );
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "wasm32")))]
unsafe fn row_tile_i8(x: &[i8], panel: &[i8], kg: usize, acc: &mut [i32; CB]) {
    *acc = [0; CB];
    for g in 0..kg {
        for c in 0..CB {
            for k in 0..4 {
                acc[c] += x[g * 4 + k] as i32 * panel[(g * CB + c) * 4 + k] as i32;
            }
        }
    }
}

/// Rows quantized to int8, symmetric to 127, rounded half to even.
#[cfg(any(test, not(target_arch = "wasm32")))]
#[inline]
fn q8_scale(row: &[f32]) -> f32 {
    row.iter().fold(0.0f32, |m, v| m.max(v.abs())).max(1e-30) / 127.0
}

#[cfg(any(test, not(target_arch = "wasm32")))]
#[inline]
fn q8(v: f32, s: f32) -> i8 {
    (v / s).round_ties_even().clamp(-127.0, 127.0) as i8
}

/// Row r of xp (tile_i8's order) from row, quantized as q8_scale and q8 do (to the bit for rows
/// without NaN); returns the scale.
#[cfg(target_arch = "wasm32")]
fn pack_i8(row: &[f32], xp: &mut [i8], r: usize) -> f32 {
    use std::arch::wasm32::*;
    let n4 = row.len() / 4;
    assert!(row.len() % 4 == 0 && r < XP && xp.len() >= n4 * XP * XG);
    // SAFETY: loads stay inside row and stores inside xp (checked above)
    unsafe {
        let p = row.as_ptr() as *const v128;
        let mut m = [f32x4_splat(0.0); 2];
        let mut i = 0;
        while i + 2 <= n4 {
            m[0] = f32x4_pmax(m[0], f32x4_abs(v128_load(p.add(i))));
            m[1] = f32x4_pmax(m[1], f32x4_abs(v128_load(p.add(i + 1))));
            i += 2;
        }
        if i < n4 {
            m[0] = f32x4_pmax(m[0], f32x4_abs(v128_load(p.add(i))));
        }
        let m = f32x4_pmax(m[0], m[1]);
        let mx = f32x4_extract_lane::<0>(m).max(f32x4_extract_lane::<1>(m)).max(f32x4_extract_lane::<2>(m)).max(f32x4_extract_lane::<3>(m));
        let s = mx.max(1e-30) / 127.0;
        let (sv, lo, hi) = (f32x4_splat(s), f32x4_splat(-127.0), f32x4_splat(127.0));
        let q4 = |g: usize| i32x4_trunc_sat_f32x4(f32x4_pmin(f32x4_pmax(f32x4_nearest(f32x4_div(v128_load(p.add(g)), sv)), lo), hi));
        let xb = xp.as_mut_ptr();
        let at = |g: usize| xb.add((g * XP + r) * XG) as *mut v128;
        let mut g = 0;
        while g + 4 <= n4 {
            let q = i8x16_narrow_i16x8(i16x8_narrow_i32x4(q4(g), q4(g + 1)), i16x8_narrow_i32x4(q4(g + 2), q4(g + 3)));
            v128_store(at(g), i8x16_shuffle::<0, 1, 0, 1, 0, 1, 0, 1, 2, 3, 2, 3, 2, 3, 2, 3>(q, q));
            v128_store(at(g + 1), i8x16_shuffle::<4, 5, 4, 5, 4, 5, 4, 5, 6, 7, 6, 7, 6, 7, 6, 7>(q, q));
            v128_store(at(g + 2), i8x16_shuffle::<8, 9, 8, 9, 8, 9, 8, 9, 10, 11, 10, 11, 10, 11, 10, 11>(q, q));
            v128_store(at(g + 3), i8x16_shuffle::<12, 13, 12, 13, 12, 13, 12, 13, 14, 15, 14, 15, 14, 15, 14, 15>(q, q));
            g += 4;
        }
        while g < n4 {
            let z = i32x4_splat(0);
            let q = i8x16_narrow_i16x8(i16x8_narrow_i32x4(q4(g), z), z);
            v128_store(at(g), i8x16_shuffle::<0, 1, 0, 1, 0, 1, 0, 1, 2, 3, 2, 3, 2, 3, 2, 3>(q, q));
            g += 1;
        }
        s
    }
}

impl Linear {
    /// From a (cout, cin) weight, as torch stores it.
    pub fn new(w: &[f32], b: &[f32], cout: usize, cin: usize) -> Linear {
        assert_eq!(w.len(), cout * cin);
        assert_eq!(b.len(), cout);
        let np = (cout + CB - 1) / CB;
        let mut panels = vec![0.0; np * cin * CB];
        for o in 0..cout {
            let (p, c) = (o / CB, o % CB);
            for i in 0..cin {
                panels[(p * cin + i) * CB + c] = w[o * cin + i];
            }
        }
        let mut bp = vec![0.0; np * CB];
        bp[..cout].copy_from_slice(b);
        Linear { cin, cout, panels, qpanels: Vec::new(), wscale: Vec::new(), b: bp }
    }

    /// From an int8 (cout, cin) weight and its scale per output.
    pub fn new_i8(w: &[i8], scale: &[f32], b: &[f32], cout: usize, cin: usize) -> Result<Linear> {
        assert_eq!(w.len(), cout * cin);
        assert_eq!(scale.len(), cout);
        assert_eq!(b.len(), cout);
        #[cfg(target_arch = "aarch64")]
        if !std::arch::is_aarch64_feature_detected!("dotprod") {
            return err("int8 weights need the dotprod extension, which this CPU lacks");
        }
        if cin % 4 != 0 {
            return err(format!("an int8 Linear needs inputs in fours, not {cin}"));
        }
        let (np, kg) = ((cout + CB - 1) / CB, cin / 4);
        let mut q = vec![0i8; np * kg * CB * 4];
        for o in 0..cout {
            let (p, c) = (o / CB, o % CB);
            for i in 0..cin {
                // wasm: quad's order, each four outputs' inputs 0 and 1, then 2 and 3
                #[cfg(target_arch = "wasm32")]
                let at = (p * kg + i / 4) * CB * 4 + (c / 4) * 16 + (i % 4 / 2) * 8 + (c % 4) * 2 + i % 2;
                #[cfg(not(target_arch = "wasm32"))]
                let at = ((p * kg + i / 4) * CB + c) * 4 + i % 4;
                q[at] = w[o * cin + i];
            }
        }
        let mut bp = vec![0.0; np * CB];
        bp[..cout].copy_from_slice(b);
        let mut sp = vec![0.0; np * CB];
        sp[..cout].copy_from_slice(scale);
        Ok(Linear { cin, cout, panels: Vec::new(), qpanels: q, wscale: sp, b: bp })
    }

    pub fn is_int8(&self) -> bool {
        !self.qpanels.is_empty()
    }

    /// Int8 when the file holds {prefix}.wscale.
    pub fn load(ws: &Weights, prefix: &str, cout: usize, cin: usize) -> Result<Linear> {
        let b = ws.shaped(&format!("{prefix}.bias"), &[cout])?;
        if ws.has(&format!("{prefix}.wscale")) {
            let w = ws.shaped_i8(&format!("{prefix}.weight"), &[cout, cin])?;
            return Linear::new_i8(w, ws.shaped(&format!("{prefix}.wscale"), &[cout])?, b, cout, cin);
        }
        let w = ws.shaped(&format!("{prefix}.weight"), &[cout, cin])?;
        Ok(Linear::new(w, b, cout, cin))
    }

    fn forward_i8(&self, x: &[f32], t: usize, out: &mut [f32]) {
        let (cin, cout) = (self.cin, self.cout);
        let (np, kg) = ((cout + CB - 1) / CB, cin / 4);
        #[cfg(not(target_arch = "wasm32"))]
        if t == 1 && kg % 2 == 0 {
            let s = q8_scale(x);
            let q: Vec<i8> = x.iter().map(|&v| q8(v, s)).collect();
            let mut acc = [0i32; CB];
            for p in 0..np {
                // SAFETY: the kernel checks its buffer lengths; new_i8 checked for dotprod.
                unsafe { row_tile_i8(&q, &self.qpanels[p * kg * CB * 4..(p + 1) * kg * CB * 4], kg, &mut acc) };
                for c in 0..CB.min(cout - p * CB) {
                    out[p * CB + c] = acc[c] as f32 * (s * self.wscale[p * CB + c]) + self.b[p * CB + c];
                }
            }
            return;
        }
        let mut xp = vec![0i8; kg * XP * XG];
        #[cfg(not(target_arch = "wasm32"))]
        let mut qrow = vec![0i8; cin];
        let mut sx = [0.0f32; RB];
        let mut acc = [[0i32; CB]; RB];
        let mut r0 = 0;
        while r0 < t {
            let rn = RB.min(t - r0);
            // wasm's tile reads only the first rn rows
            #[cfg(not(target_arch = "wasm32"))]
            if rn < RB {
                xp.fill(0);
            }
            for r in 0..rn {
                let row = &x[(r0 + r) * cin..(r0 + r + 1) * cin];
                #[cfg(target_arch = "wasm32")]
                {
                    sx[r] = pack_i8(row, &mut xp, r);
                }
                #[cfg(not(target_arch = "wasm32"))]
                {
                    let s = q8_scale(row);
                    sx[r] = s;
                    for (q, &v) in qrow.iter_mut().zip(row) {
                        *q = q8(v, s);
                    }
                    for g in 0..kg {
                        xp[(g * XP + r) * XG..(g * XP + r + 1) * XG].copy_from_slice(&qrow[g * 4..g * 4 + 4]);
                    }
                }
            }
            for p in 0..np {
                let panel = &self.qpanels[p * kg * CB * 4..(p + 1) * kg * CB * 4];
                // SAFETY: the kernel checks its buffer lengths; new_i8 checked for dotprod.
                unsafe { tile_i8(&xp, panel, kg, rn, &mut acc) };
                let n = CB.min(cout - p * CB);
                #[cfg(target_arch = "wasm32")]
                if n == CB {
                    use std::arch::wasm32::*;
                    let o = r0 * cout + p * CB;
                    assert!(out.len() >= o + (rn - 1) * cout + CB && self.wscale.len() >= p * CB + CB && self.b.len() >= p * CB + CB);
                    // SAFETY: CB values from each (checked above)
                    unsafe {
                        let (ws, b) = (self.wscale.as_ptr().add(p * CB) as *const v128, self.b.as_ptr().add(p * CB) as *const v128);
                        for r in 0..rn {
                            let (a, y, s) = (acc[r].as_ptr() as *const v128, out.as_mut_ptr().add(o + r * cout) as *mut v128, f32x4_splat(sx[r]));
                            for j in 0..CB / 4 {
                                let v = f32x4_mul(f32x4_convert_i32x4(v128_load(a.add(j))), f32x4_mul(s, v128_load(ws.add(j))));
                                v128_store(y.add(j), f32x4_add(v, v128_load(b.add(j))));
                            }
                        }
                    }
                    continue;
                }
                for r in 0..rn {
                    let o = (r0 + r) * cout + p * CB;
                    for c in 0..n {
                        out[o + c] = acc[r][c] as f32 * (sx[r] * self.wscale[p * CB + c]) + self.b[p * CB + c];
                    }
                }
            }
            r0 += rn;
        }
    }

    pub fn forward(&self, x: &[f32], t: usize, out: &mut [f32]) {
        if self.is_int8() {
            assert_eq!(x.len(), t * self.cin);
            assert_eq!(out.len(), t * self.cout);
            return self.forward_i8(x, t, out);
        }
        let (cin, cout) = (self.cin, self.cout);
        assert_eq!(x.len(), t * cin);
        assert_eq!(out.len(), t * cout);
        let np = (cout + CB - 1) / CB;
        if t == 1 {
            let panel = |p: usize| &self.panels[p * cin * CB..(p + 1) * cin * CB];
            let bias = |p: usize| &self.b[p * CB..(p + 1) * CB];
            let mut p = 0;
            while p < np {
                let n = CB.min(cout - p * CB);
                if p + 1 < np {
                    let mut acc = [[0.0; CB]; 2];
                    row_tiles(x, [panel(p), panel(p + 1)], [bias(p), bias(p + 1)], &mut acc);
                    out[p * CB..p * CB + n].copy_from_slice(&acc[0][..n]);
                    let n1 = CB.min(cout - (p + 1) * CB);
                    out[(p + 1) * CB..(p + 1) * CB + n1].copy_from_slice(&acc[1][..n1]);
                    p += 2;
                } else {
                    let mut acc = [[0.0; CB]; 1];
                    row_tiles(x, [panel(p)], [bias(p)], &mut acc);
                    out[p * CB..p * CB + n].copy_from_slice(&acc[0][..n]);
                    p += 1;
                }
            }
            return;
        }
        let mut xp = vec![0.0f32; cin * XP];
        let mut acc = [[0.0f32; CB]; RB];
        let mut r0 = 0;
        while r0 < t {
            let rn = RB.min(t - r0);
            for r in 0..RB {
                for i in 0..cin {
                    xp[i * XP + r] = if r < rn { x[(r0 + r) * cin + i] } else { 0.0 };
                }
            }
            for p in 0..np {
                let panel = &self.panels[p * cin * CB..(p + 1) * cin * CB];
                let bias: &[f32; CB] = self.b[p * CB..(p + 1) * CB].try_into().unwrap();
                tile(&xp, panel, cin, bias, &mut acc);
                let n = CB.min(cout - p * CB);
                for r in 0..rn {
                    let o = (r0 + r) * cout + p * CB;
                    out[o..o + n].copy_from_slice(&acc[r][..n]);
                }
            }
            r0 += rn;
        }
    }
}

pub struct LayerNorm {
    w: Vec<f32>,
    b: Vec<f32>,
    eps: f32,
}

impl LayerNorm {
    /// torch's default epsilon, 1e-5.
    pub fn load(ws: &Weights, prefix: &str, dim: usize) -> Result<LayerNorm> {
        LayerNorm::load_eps(ws, prefix, dim, 1e-5)
    }

    /// From its scale and shift, torch's default epsilon.
    pub fn new(w: Vec<f32>, b: Vec<f32>) -> LayerNorm {
        assert_eq!(w.len(), b.len());
        LayerNorm { w, b, eps: 1e-5 }
    }

    pub fn load_eps(ws: &Weights, prefix: &str, dim: usize, eps: f32) -> Result<LayerNorm> {
        Ok(LayerNorm {
            w: ws.shaped(&format!("{prefix}.weight"), &[dim])?.to_vec(),
            b: ws.shaped(&format!("{prefix}.bias"), &[dim])?.to_vec(),
            eps,
        })
    }

    pub fn forward(&self, x: &mut [f32]) {
        let d = self.w.len();
        // four rows at a time, each row's sums in the order it alone would take (iter's sum,
        // from -0.0), side by side
        let mut fours = x.chunks_exact_mut(4 * d);
        for b in &mut fours {
            let mut mean = [-0.0f32; 4];
            for c in 0..d {
                for r in 0..4 {
                    mean[r] += b[r * d + c];
                }
            }
            let mean = mean.map(|m| m / d as f32);
            let mut var = [-0.0f32; 4];
            for c in 0..d {
                for r in 0..4 {
                    var[r] += (b[r * d + c] - mean[r]) * (b[r * d + c] - mean[r]);
                }
            }
            for (r, row) in b.chunks_exact_mut(d).enumerate() {
                self.scale(row, mean[r], var[r] / d as f32);
            }
        }
        for row in fours.into_remainder().chunks_exact_mut(d) {
            let mean = row.iter().sum::<f32>() / d as f32;
            let var = row.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / d as f32;
            self.scale(row, mean, var);
        }
    }

    #[inline(always)]
    fn scale(&self, row: &mut [f32], mean: f32, var: f32) {
        let inv = 1.0 / (var + self.eps).sqrt();
        for c in 0..row.len() {
            row[c] = (row[c] - mean) * inv * self.w[c] + self.b[c];
        }
    }
}

/// a b + c, fused where the hardware has it (wasm has not).
#[inline(always)]
fn madd(a: f32, b: f32, c: f32) -> f32 {
    #[cfg(target_arch = "wasm32")]
    return a * b + c;
    #[cfg(not(target_arch = "wasm32"))]
    a.mul_add(b, c)
}

/// e^x for x <= 0 to about 2 ulp, branch free so loops over it vectorize.
#[inline(always)]
fn exp_neg(x: f32) -> f32 {
    let x = x.max(-87.0);
    let n = (x * std::f32::consts::LOG2_E).round_ties_even();
    let r = madd(n, -0.693_145_75, x);
    let r = madd(n, -1.428_606_8e-6, r);
    let p = 1.987_569_1e-4f32;
    let p = madd(p, r, 1.398_199_9e-3);
    let p = madd(p, r, 8.333_452e-3);
    let p = madd(p, r, 4.166_579_6e-2);
    let p = madd(p, r, 1.666_666_5e-1);
    let p = madd(p, r, 5e-1);
    let p = madd(p * r, r, r) + 1.0;
    p * f32::from_bits(((n as i32 + 127) as u32) << 23)
}

/// erf to about 1.5e-7 (Abramowitz and Stegun 7.1.26).
#[inline(always)]
pub fn erf(x: f32) -> f32 {
    let a = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * a);
    let y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp_neg(-a * a);
    y.copysign(x)
}

#[inline(always)]
pub fn gelu(x: f32) -> f32 {
    0.5 * x * (1.0 + erf(x * std::f32::consts::FRAC_1_SQRT_2))
}

#[cfg(not(target_arch = "wasm32"))]
pub fn gelu_slice(x: &mut [f32]) {
    for v in x.iter_mut() {
        *v = gelu(*v);
    }
}

/// gelu on four lanes, the same arithmetic as the scalar's.
#[cfg(target_arch = "wasm32")]
#[inline(always)]
fn gelu4(x: std::arch::wasm32::v128) -> std::arch::wasm32::v128 {
    use std::arch::wasm32::*;
    let k = f32x4_splat;
    let (mul, add, sub) = (f32x4_mul, f32x4_add, f32x4_sub);
    let z = mul(x, k(std::f32::consts::FRAC_1_SQRT_2));
    let a = f32x4_abs(z);
    let t = f32x4_div(k(1.0), add(k(1.0), mul(k(0.3275911), a)));
    let p = mul(sub(mul(k(1.061405429), t), k(1.453152027)), t);
    let p = add(mul(sub(mul(add(p, k(1.421413741)), t), k(0.284496736)), t), k(0.254829592));
    // exp_neg(-a a)
    let e = f32x4_max(f32x4_neg(mul(a, a)), k(-87.0));
    let n = f32x4_nearest(mul(e, k(std::f32::consts::LOG2_E)));
    let r = add(mul(n, k(-0.693_145_75)), e);
    let r = add(mul(n, k(-1.428_606_8e-6)), r);
    let q = add(mul(k(1.987_569_1e-4), r), k(1.398_199_9e-3));
    let q = add(mul(q, r), k(8.333_452e-3));
    let q = add(mul(q, r), k(4.166_579_6e-2));
    let q = add(mul(q, r), k(1.666_666_5e-1));
    let q = add(mul(q, r), k(5e-1));
    let q = add(add(mul(mul(q, r), r), r), k(1.0));
    let e = mul(q, i32x4_shl(i32x4_add(i32x4_trunc_sat_f32x4(n), i32x4_splat(127)), 23));
    let y = sub(k(1.0), mul(mul(p, t), e));
    let y = v128_bitselect(z, y, i32x4_splat(i32::MIN));
    mul(mul(k(0.5), x), add(k(1.0), y))
}

#[cfg(target_arch = "wasm32")]
pub fn gelu_slice(x: &mut [f32]) {
    use std::arch::wasm32::*;
    let mut ch = x.chunks_exact_mut(8);
    for c in &mut ch {
        let p = c.as_mut_ptr() as *mut v128;
        // SAFETY: c holds eight f32s; v128 loads and stores need no alignment
        unsafe {
            let (a, b) = (gelu4(v128_load(p)), gelu4(v128_load(p.add(1))));
            v128_store(p, a);
            v128_store(p.add(1), b);
        }
    }
    for v in ch.into_remainder() {
        *v = gelu(*v);
    }
}

/// Depthwise conv over time, zero padded, weights stored (k, dim).
pub struct DwConv {
    dim: usize,
    k: usize,
    w: Vec<f32>,
    b: Vec<f32>,
}

impl DwConv {
    pub fn load(ws: &Weights, prefix: &str, dim: usize, k: usize) -> Result<DwConv> {
        let w = ws.shaped(&format!("{prefix}.weight"), &[dim, 1, k])?;
        let mut wk = vec![0.0; k * dim];
        for c in 0..dim {
            for j in 0..k {
                wk[j * dim + c] = w[c * k + j];
            }
        }
        Ok(DwConv { dim, k, w: wk, b: ws.shaped(&format!("{prefix}.bias"), &[dim])?.to_vec() })
    }

    pub fn forward(&self, x: &[f32], t: usize, out: &mut [f32]) {
        self.forward_rows(x, t, 0, t, out);
    }

    pub fn radius(&self) -> usize {
        self.k / 2
    }

    /// Output rows [from, from + n) of x (t rows), zero padded outside x.
    pub fn forward_rows(&self, x: &[f32], t: usize, from: usize, n: usize, out: &mut [f32]) {
        let (d, k, p) = (self.dim, self.k, self.k / 2);
        assert!(from + n <= t && x.len() == t * d && out.len() == n * d);
        for (r, i) in (from..from + n).enumerate() {
            let o = &mut out[r * d..(r + 1) * d];
            o.copy_from_slice(&self.b);
            for j in 0..k {
                let src = i as isize + j as isize - p as isize;
                if src < 0 || src >= t as isize {
                    continue;
                }
                let xs = &x[src as usize * d..(src as usize + 1) * d];
                let w = &self.w[j * d..(j + 1) * d];
                for c in 0..d {
                    o[c] += w[c] * xs[c];
                }
            }
        }
    }
}

/// A full conv over time (zero padded, odd kernel) as im2col and a Linear.
pub struct Conv1d {
    cin: usize,
    /// Each tap's channel stride in the window: cin, or cin rounded up to fours for int8.
    cp: usize,
    k: usize,
    lin: Linear,
}

impl Conv1d {
    /// Int8 when the file holds {prefix}.wscale (one scale per output over its whole window).
    pub fn load(ws: &Weights, prefix: &str, cout: usize, cin: usize, k: usize) -> Result<Conv1d> {
        let b = ws.shaped(&format!("{prefix}.bias"), &[cout])?;
        let wn = format!("{prefix}.weight");
        if ws.has(&format!("{prefix}.wscale")) {
            let w = ws.shaped_i8(&wn, &[cout, cin, k])?;
            let cp = (cin + 3) / 4 * 4;
            let mut w2 = vec![0i8; cout * k * cp];
            for o in 0..cout {
                for c in 0..cin {
                    for j in 0..k {
                        w2[o * k * cp + j * cp + c] = w[(o * cin + c) * k + j];
                    }
                }
            }
            let lin = Linear::new_i8(&w2, ws.shaped(&format!("{prefix}.wscale"), &[cout])?, b, cout, k * cp)?;
            return Ok(Conv1d { cin, cp, k, lin });
        }
        let w = ws.shaped(&wn, &[cout, cin, k])?;
        let mut w2 = vec![0.0; cout * k * cin];
        for o in 0..cout {
            for c in 0..cin {
                for j in 0..k {
                    w2[o * k * cin + j * cin + c] = w[(o * cin + c) * k + j];
                }
            }
        }
        Ok(Conv1d { cin, cp: cin, k, lin: Linear::new(&w2, b, cout, k * cin) })
    }

    pub fn forward(&self, x: &[f32], t: usize, out: &mut [f32]) {
        self.forward_rows(x, t, 0, t, out);
    }

    /// Output rows [from, from + n) of x (t rows), zero padded outside x.
    pub fn forward_rows(&self, x: &[f32], t: usize, from: usize, n: usize, out: &mut [f32]) {
        let (cin, cp, k, p) = (self.cin, self.cp, self.k, self.k / 2);
        assert!(from + n <= t && x.len() == t * cin);
        let mut col = vec![0.0; n * k * cp];
        for (r, i) in (from..from + n).enumerate() {
            for j in 0..k {
                let src = i as isize + j as isize - p as isize;
                if src < 0 || src >= t as isize {
                    continue;
                }
                let at = (r * k + j) * cp;
                col[at..at + cin].copy_from_slice(&x[src as usize * cin..(src as usize + 1) * cin]);
            }
        }
        self.lin.forward(&col, n, out);
    }

    pub fn radius(&self) -> usize {
        self.k / 2
    }

    pub fn cout(&self) -> usize {
        self.lin.cout
    }
}

pub struct ConvNeXt {
    dim: usize,
    dw: DwConv,
    norm: LayerNorm,
    pw1: Linear,
    pw2: Linear,
    gamma: Vec<f32>,
}

impl ConvNeXt {
    pub fn load(ws: &Weights, prefix: &str, dim: usize, mult: usize, k: usize) -> Result<ConvNeXt> {
        ConvNeXt::load_eps(ws, prefix, dim, mult, k, 1e-5)
    }

    /// With its norm's epsilon.
    pub fn load_eps(ws: &Weights, prefix: &str, dim: usize, mult: usize, k: usize, eps: f32) -> Result<ConvNeXt> {
        Ok(ConvNeXt {
            dim,
            dw: DwConv::load(ws, &format!("{prefix}.dw"), dim, k)?,
            norm: LayerNorm::load_eps(ws, &format!("{prefix}.norm"), dim, eps)?,
            pw1: Linear::load(ws, &format!("{prefix}.pw1"), dim * mult, dim)?,
            pw2: Linear::load(ws, &format!("{prefix}.pw2"), dim, dim * mult)?,
            gamma: ws.shaped(&format!("{prefix}.gamma"), &[dim])?.to_vec(),
        })
    }

    /// In place on x (T, dim).
    pub fn forward(&self, x: &mut [f32], t: usize) {
        let mut out = vec![0.0; x.len()];
        self.forward_rows(x, t, 0, t, &mut out);
        x.copy_from_slice(&out);
    }

    /// Output rows [from, from + n) of x (t rows), zero padded outside x.
    pub fn forward_rows(&self, x: &[f32], t: usize, from: usize, n: usize, out: &mut [f32]) {
        let d = self.dim;
        let mut y = vec![0.0; n * d];
        self.dw.forward_rows(x, t, from, n, &mut y);
        self.norm.forward(&mut y);
        let mut h = vec![0.0; n * self.pw1.cout];
        self.pw1.forward(&y, n, &mut h);
        gelu_slice(&mut h);
        self.pw2.forward(&h, n, &mut y);
        for r in 0..n {
            for c in 0..d {
                out[r * d + c] = x[(from + r) * d + c] + self.gamma[c] * y[r * d + c];
            }
        }
    }

    pub fn radius(&self) -> usize {
        self.dw.k / 2
    }

    pub fn dim(&self) -> usize {
        self.dim
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::Rng;

    /// The int8 kernel against the same arithmetic done plainly.
    #[test]
    fn int8_linear_exact() {
        let mut rng = Rng::new(7);
        for &(t, cin, cout) in &[(1, 4, 1), (7, 256, 768), (13, 1152, 384), (6, 384, 88), (25, 256, 1026), (5, 20, 33), (9, 104, 40)] {
            let w = rng.gaussian(cout * cin);
            let x = rng.gaussian(t * cin);
            let b = rng.gaussian(cout);
            let mut q = vec![0i8; cout * cin];
            let mut sw = vec![0.0f32; cout];
            for o in 0..cout {
                sw[o] = q8_scale(&w[o * cin..(o + 1) * cin]);
                for i in 0..cin {
                    q[o * cin + i] = q8(w[o * cin + i], sw[o]);
                }
            }
            let lin = Linear::new_i8(&q, &sw, &b, cout, cin).unwrap();
            let mut y = vec![0.0; t * cout];
            lin.forward(&x, t, &mut y);
            for r in 0..t {
                let row = &x[r * cin..(r + 1) * cin];
                let sx = q8_scale(row);
                for o in 0..cout {
                    let acc: i32 = (0..cin).map(|i| q8(row[i], sx) as i32 * q[o * cin + i] as i32).sum();
                    let want = acc as f32 * (sx * sw[o]) + b[o];
                    assert_eq!(y[r * cout + o], want, "t {t} cin {cin} cout {cout} at {r},{o}");
                }
            }
        }
    }
}

#[cfg(test)]
mod gelu_tests {
    use super::*;
    use crate::rng::Rng;

    #[test]
    fn exp_and_gelu_accuracy() {
        let mut worst = 0.0f64;
        for i in 0..=200000 {
            let x = -87.0 + 87.0 * i as f32 / 200000.0;
            let e = (exp_neg(x) as f64 - (x as f64).exp()).abs() / (x as f64).exp();
            worst = worst.max(e);
        }
        assert!(worst < 5e-7, "exp relative error {worst}");
        let mut gw = 0.0f64;
        for i in 0..=100000 {
            let x = -10.0 + 20.0 * i as f32 / 100000.0;
            let xd = x as f64;
            let want = 0.5 * xd * (1.0 + libm_erf(xd / 2f64.sqrt()));
            gw = gw.max((gelu(x) as f64 - want).abs());
        }
        assert!(gw < 2e-6, "gelu abs error {gw}");
    }

    /// LayerNorm, four rows at a time, is each row alone to the bit.
    #[test]
    fn layer_norm_rows_exact() {
        let mut rng = Rng::new(3);
        for &(t, d) in &[(1, 8), (4, 256), (7, 384), (9, 20)] {
            let w = rng.gaussian(d);
            let b = rng.gaussian(d);
            let ln = LayerNorm { w: w.clone(), b: b.clone(), eps: 1e-5 };
            let mut x: Vec<f32> = rng.gaussian(t * d).iter().map(|v| v * 3.0 + 0.5).collect();
            x[..d].fill(-0.0);
            let (w, b) = (&w, &b);
            let want: Vec<f32> = x
                .chunks_exact(d)
                .flat_map(|row| {
                    let mean = row.iter().sum::<f32>() / d as f32;
                    let var = row.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / d as f32;
                    let inv = 1.0 / (var + 1e-5f32).sqrt();
                    (0..d).map(move |c| (row[c] - mean) * inv * w[c] + b[c]).collect::<Vec<_>>()
                })
                .collect();
            ln.forward(&mut x);
            for (i, (a, e)) in x.iter().zip(&want).enumerate() {
                assert_eq!(a.to_bits(), e.to_bits(), "t {t} d {d} at {i}");
            }
        }
    }

    /// gelu_slice, however it is vectorized, is gelu to the bit.
    #[test]
    fn gelu_slice_exact() {
        let mut x: Vec<f32> = (0..=400003).map(|i| -20.0 + 40.0 * i as f32 / 400003.0).collect();
        x.extend([0.0, -0.0, 1e-30, -1e-30, 87.0, -87.0, 1e6, -1e6, f32::MAX, f32::MIN]);
        let mut y = x.clone();
        gelu_slice(&mut y);
        for (a, b) in x.iter().zip(&y) {
            assert_eq!(gelu(*a).to_bits(), b.to_bits(), "at {a}");
        }
    }

    /// erf in f64 by its Taylor series near 0 and continued fraction beyond (reference only).
    fn libm_erf(x: f64) -> f64 {
        let a = x.abs();
        let r = if a < 3.0 {
            let (mut term, mut sum, mut n) = (a, a, 0.0);
            loop {
                n += 1.0;
                term *= -a * a / n;
                let add = term / (2.0 * n + 1.0);
                sum += add;
                if add.abs() < 1e-17 {
                    break;
                }
            }
            sum * 2.0 / std::f64::consts::PI.sqrt()
        } else {
            let mut f = 0.0;
            for k in (1..60).rev() {
                f = k as f64 / 2.0 / (a + f);
            }
            1.0 - (-a * a).exp() / std::f64::consts::PI.sqrt() / (a + f)
        };
        r.copysign(x)
    }
}
