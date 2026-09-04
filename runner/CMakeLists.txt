# The MTE runner, built in place.
#
# Adapted from shift_service/mte_control/online/CMakeLists.txt, which reached
# up into ../src for the driver. Here the driver sits beside main.c, so this
# tree builds on its own with nothing outside it.
cmake_minimum_required(VERSION 3.10)

project(mte_run C)

find_package(PkgConfig REQUIRED)
pkg_check_modules(LIBUSB REQUIRED libusb-1.0)

add_library(NoticeCENS_SCALER STATIC
  src/NoticeCENS_SCALER.c
)

target_include_directories(NoticeCENS_SCALER
  PUBLIC
    src
    ${LIBUSB_INCLUDE_DIRS}
)

target_compile_options(NoticeCENS_SCALER PRIVATE
  -Wall
  -Wundef
  -Wunused
  -Wstrict-prototypes
  -Werror-implicit-function-declaration
  -Wno-pointer-sign
  -Wshadow
  -O2
  -fPIC
)

target_link_libraries(NoticeCENS_SCALER
  PUBLIC
    ${LIBUSB_LIBRARIES}
)

add_executable(run_mte main.c)
set_target_properties(run_mte PROPERTIES SUFFIX ".exe")

target_include_directories(run_mte PRIVATE src)
target_link_libraries(run_mte
  PRIVATE
    NoticeCENS_SCALER
    m
)
