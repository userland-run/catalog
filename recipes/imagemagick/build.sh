#!/usr/bin/env bash
# Build ImageMagick 7 into ./out/magick as ONE static RV64GC musl ELF.
#
# Toolchain: `zig cc -target riscv64-linux-musl` (zig bundles musl + a clang
# cross-toolchain, like the other C recipes). The image delegates are built from
# pinned source and linked statically into the same binary:
#   zlib · libjpeg-turbo · libpng · libwebp (+ sharpyuv, mux, demux)
# ImageMagick itself: no OpenMP, no threads, no X11, no modules, no shared libs,
# no external delegate programs, and --enable-zero-configuration (policy/
# delegates/colors XML compiled in — nothing read from /etc or /usr/share).
#
# Q8 (8-bit quantum, no HDRI) by default — measured ~faster/smaller than Q16 on
# nano (see recipe.toml). Override with QUANTUM=16 ./build.sh for a Q16 build.
set -euo pipefail
cd "$(dirname "$0")"
. ../../tools/lib/recipe-pin.sh   # clone_pinned / fetch_sha256 (supply-chain pins)

QUANTUM="${QUANTUM:-8}"
command -v zig >/dev/null 2>&1 || { echo "ERROR: zig not on PATH (needed for the musl cross-compile; CI uses 0.13.0)"; exit 1; }
JOBS="$( (nproc || sysctl -n hw.ncpu) 2>/dev/null || echo 4)"

HERE="$PWD"
B="$HERE/.build"
PREFIX="$B/prefix"
rm -rf "$B" out
mkdir -p "$B/bin" "$PREFIX" out

# --- zig wrappers: autoconf/cmake want a single-word compiler path ---
TARGET_FLAGS="-target riscv64-linux-musl -march=baseline_rv64"
# (cmake's ABI probe passes -Wl,-v, which zig's linker rejects — drop it.)
for tool in cc c++; do
cat > "$B/bin/rv-$tool" <<EOF
#!/bin/sh
for a; do shift; [ "\$a" = "-Wl,-v" ] || set -- "\$@" "\$a"; done
exec zig $tool $TARGET_FLAGS "\$@"
EOF
done
printf '#!/bin/sh\nexec zig ar "$@"\n' > "$B/bin/rv-ar"
printf '#!/bin/sh\nexec zig ranlib "$@"\n' > "$B/bin/rv-ranlib"
chmod +x "$B/bin/"*
export PATH="$B/bin:$PATH"
CC="$B/bin/rv-cc"; CXX="$B/bin/rv-c++"; AR="$B/bin/rv-ar"; RANLIB="$B/bin/rv-ranlib"
OPT="-O2"

cat > "$B/toolchain.cmake" <<EOF
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)
set(CMAKE_C_COMPILER $CC)
set(CMAKE_CXX_COMPILER $CXX)
set(CMAKE_AR $AR CACHE FILEPATH "")
set(CMAKE_RANLIB $RANLIB CACHE FILEPATH "")
set(CMAKE_FIND_ROOT_PATH $PREFIX)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
EOF
CMAKE_COMMON=(-DCMAKE_TOOLCHAIN_FILE="$B/toolchain.cmake" -DCMAKE_BUILD_TYPE=Release
  -DCMAKE_C_FLAGS_RELEASE="$OPT -DNDEBUG" -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=OFF)

# Only our cross-built .pc files — never the host's.
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig" PKG_CONFIG_PATH=""

# --- zlib ---
clone_pinned https://github.com/madler/zlib v1.3.1 51b7f2abdade71cd9bb0e7a373ef2610ec6f9daf "$B/zlib"
( cd "$B/zlib"
  CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$OPT" CHOST=riscv64 ./configure --static --prefix="$PREFIX"
  make -j"$JOBS" libz.a && make install )

# --- libjpeg-turbo (no SIMD on riscv64 in 3.1.x; C codec) ---
clone_pinned https://github.com/libjpeg-turbo/libjpeg-turbo 3.1.4.1 9217719d3a58633923b096af4c1d50d304768a64 "$B/jpeg"
cmake -S "$B/jpeg" -B "$B/jpeg/b" "${CMAKE_COMMON[@]}" \
  -DENABLE_SHARED=OFF -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DWITH_TURBOJPEG=OFF -DWITH_TOOLS=OFF -DWITH_TESTS=OFF
cmake --build "$B/jpeg/b" -j"$JOBS" && cmake --install "$B/jpeg/b"

# --- libpng ---
clone_pinned https://github.com/pnggroup/libpng v1.6.59 cd952f49f95bb27154ae77dbb103032d95f6e580 "$B/png"
cmake -S "$B/png" -B "$B/png/b" "${CMAKE_COMMON[@]}" \
  -DPNG_SHARED=OFF -DPNG_STATIC=ON -DPNG_TESTS=OFF -DPNG_TOOLS=OFF -DPNG_FRAMEWORK=OFF \
  -DPNG_HARDWARE_OPTIMIZATIONS=OFF -DZLIB_ROOT="$PREFIX"
cmake --build "$B/png/b" -j"$JOBS" && cmake --install "$B/png/b"

# --- libwebp (+ sharpyuv, mux, demux) ---
clone_pinned https://github.com/webmproject/libwebp v1.6.0 4fa21912338357f89e4fd51cf2368325b59e9bd9 "$B/webp"
cmake -S "$B/webp" -B "$B/webp/b" "${CMAKE_COMMON[@]}" \
  -DWEBP_BUILD_ANIM_UTILS=OFF -DWEBP_BUILD_CWEBP=OFF -DWEBP_BUILD_DWEBP=OFF -DWEBP_BUILD_GIF2WEBP=OFF \
  -DWEBP_BUILD_IMG2WEBP=OFF -DWEBP_BUILD_VWEBP=OFF -DWEBP_BUILD_WEBPINFO=OFF -DWEBP_BUILD_WEBPMUX=OFF \
  -DWEBP_BUILD_EXTRAS=OFF -DWEBP_BUILD_LIBWEBPMUX=ON -DWEBP_USE_THREAD=OFF -DWEBP_ENABLE_SIMD=OFF
cmake --build "$B/webp/b" -j"$JOBS" && cmake --install "$B/webp/b"

# --- ImageMagick 7 ---
clone_pinned https://github.com/ImageMagick/ImageMagick 7.1.2-33 211e5b975a0019a88dcef5f84c1193f46738d815 "$B/im"
# 7.1.2-33 regression: in-place `magick mogrify` fails with
# "NoEncodeDelegateForThisImageFormat `'" (issue #9011). Backport of upstream
# commit 2c1021b8a4 (verbatim .diff); drop when bumping past 7.1.2-33.
git -C "$B/im" apply "$HERE/patches/mogrify-inplace-9011.patch"
# ac_cv_func_mmap=no: no FILE-backed mmap (MapBlob / disk pixel cache). nano
# serves file mmap through the host FS bridge only partially; IM then falls
# back to plain read()/write(), which is all it needs. (Anonymous memory still
# comes from musl malloc.) ac_cv_func_times=no: times() (syscall 153) is not in
# the nano syscall set — IM's timers fall back to clock()/clock_gettime.
# pkg-config --static: libwebp needs -lsharpyuv.
( cd "$B/im"
  ac_cv_func_mmap=no ac_cv_func_mmap_fixed_mapped=no ac_cv_func_times=no PKG_CONFIG="pkg-config --static" CC="$CC" CXX="$CXX" AR="$AR" RANLIB="$RANLIB" \
  CFLAGS="$OPT" CPPFLAGS="-I$PREFIX/include" LDFLAGS="-static -s -L$PREFIX/lib" \
  ./configure --host=riscv64-linux-musl --build="$(./config/config.guess)" --prefix=/usr \
    --disable-shared --enable-static --without-modules --disable-docs \
    --disable-openmp --without-threads --disable-opencl --without-x \
    --enable-zero-configuration --disable-installed --disable-deprecated \
    --with-quantum-depth="$QUANTUM" --disable-hdri \
    --without-magick-plus-plus --without-perl \
    --with-zlib --with-jpeg --with-png --with-webp \
    --without-bzlib --without-lzma --without-zstd --without-zip --without-xml \
    --without-fontconfig --without-freetype --without-raqm --without-lcms \
    --without-tiff --without-openjp2 --without-heic --without-jxl --without-raw \
    --without-djvu --without-fftw --without-gvc --without-jbig --without-lqr \
    --without-pango --without-rsvg --without-wmf --without-dps --without-fpx \
    --without-gslib --without-flif --without-uhdr
  make -j"$JOBS" utilities/magick )

cp "$B/im/utilities/magick" out/magick
file out/magick || true
ls -l out/magick
