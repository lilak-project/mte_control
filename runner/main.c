#include <errno.h>
#include <dirent.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#include "NoticeCENS_SCALER.h"

#define NUM_DOWN_SCALE 3
#define NUM_INPUT_TYPES 20
#define NUM_COUNTER_CHANNELS 10
#define READ_BUFFER_BYTES (4 * 1024 * 1024)
#define PATH_BUFFER_SIZE 1024
#define PRINT_INTERVAL_SEC 10
#define COUNTER_TABLE_WIDTH 113

typedef struct {
  int down_scale[NUM_DOWN_SCALE];
  int input_type[NUM_INPUT_TYPES];
} MteSetup;

typedef struct {
  int run_number;
  int acq_time_sec;
  int count_period_ms;
  const char *setup_path;
  const char *data_dir;
  const char *converted_dir;
  int force_init;
  int monitor;
  int next_run;
  int quiet;
} RunOptions;

typedef struct {
  FILE *stamp_dat;
  FILE *stamp_txt;
  FILE *counter_dat;
  FILE *counter_txt;
  char data_run_dir[PATH_BUFFER_SIZE];
  char converted_run_dir[PATH_BUFFER_SIZE];
  unsigned long stamp_bytes;
  unsigned long counter_bytes;
  unsigned long stamp_events;
  unsigned long counter_events;
} RunFiles;

typedef struct {
  int valid;
  int index;
  int count[NUM_COUNTER_CHANNELS];
  double time_tag;
  unsigned long event_count;
} CounterSnapshot;

typedef struct {
  double count_sum[NUM_COUNTER_CHANNELS];
  unsigned long events;
} CounterStats;

static volatile sig_atomic_t signal_interrupted = 0;

static void handle_signal(int signum)
{
  (void)signum;
  signal_interrupted = 1;
}

static void print_usage(const char *program)
{
  printf("Usage: %s [run_number] [acq_time_sec] [count_period_ms] [options]\n", program);
  printf("       %s --next [acq_time_sec] [count_period_ms] [options]\n", program);
  printf("       %s --monitor [acq_time_sec] [count_period_ms] [options]\n", program);
  printf("\n");
  printf("Options:\n");
  printf("  --next            Use one higher than the largest existing run number.\n");
  printf("  --setup FILE       Setup file with down-scale and input type values.\n");
  printf("  --data-dir DIR     Directory where raw .dat files are saved. Default: data\n");
  printf("  --converted-dir DIR Directory where converted .txt files are saved. Default: converted\n");
  printf("  --force-init       Always write setup values before running.\n");
  printf("  --monitor          Run without run number and without writing files.\n");
  printf("  --quiet            Do not print per-second counter values.\n");
  printf("  -h, --help         Show this help.\n");
}

static int parse_int(const char *text, int *value)
{
  char *end = NULL;
  long parsed;

  errno = 0;
  parsed = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0')
    return -1;

  *value = (int)parsed;
  return 0;
}

static int parse_options(int argc, char **argv, RunOptions *options)
{
  const char *positional_args[3];
  int positional_count = 0;
  int i;

  options->run_number = -1;
  options->acq_time_sec = 60 * 60 * 24 * 30;
  options->count_period_ms = 1000;
  options->setup_path = NULL;
  options->data_dir = "data";
  options->converted_dir = "converted";
  options->force_init = 0;
  options->monitor = 0;
  options->next_run = 0;
  options->quiet = 0;

  for (i = 1; i < argc; ++i) {
    if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
      print_usage(argv[0]);
      return 1;
    }
    if (strcmp(argv[i], "--force-init") == 0) {
      options->force_init = 1;
      continue;
    }
    if (strcmp(argv[i], "--monitor") == 0) {
      options->monitor = 1;
      continue;
    }
    if (strcmp(argv[i], "--next") == 0) {
      if (positional_count >= 3) {
        fprintf(stderr, "Too many positional arguments: %s\n", argv[i]);
        return -1;
      }
      positional_args[positional_count++] = argv[i];
      continue;
    }
    if (strcmp(argv[i], "--quiet") == 0 || strcmp(argv[i], "--quite") == 0) {
      options->quiet = 1;
      continue;
    }
    if (strcmp(argv[i], "--setup") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "Missing value for --setup\n");
        return -1;
      }
      options->setup_path = argv[i];
      continue;
    }
    if (strcmp(argv[i], "--data-dir") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "Missing value for --data-dir\n");
        return -1;
      }
      options->data_dir = argv[i];
      continue;
    }
    if (strcmp(argv[i], "--converted-dir") == 0) {
      if (++i >= argc) {
        fprintf(stderr, "Missing value for --converted-dir\n");
        return -1;
      }
      options->converted_dir = argv[i];
      continue;
    }
    if (argv[i][0] == '-') {
      fprintf(stderr, "Unknown option: %s\n", argv[i]);
      return -1;
    }

    if (positional_count >= 3) {
      fprintf(stderr, "Too many positional arguments: %s\n", argv[i]);
      return -1;
    }
    positional_args[positional_count++] = argv[i];
  }

  if (options->monitor) {
    if (positional_count > 0 && parse_int(positional_args[0], &options->acq_time_sec) != 0) {
      fprintf(stderr, "Invalid acquisition time: %s\n", positional_args[0]);
      return -1;
    }
    if (positional_count > 1 && parse_int(positional_args[1], &options->count_period_ms) != 0) {
      fprintf(stderr, "Invalid count period: %s\n", positional_args[1]);
      return -1;
    }
    if (positional_count > 2) {
      fprintf(stderr, "--monitor accepts at most acq_time_sec and count_period_ms.\n");
      return -1;
    }
  }
  else {
    if (positional_count > 0) {
      if (strcmp(positional_args[0], "--next") == 0) {
        options->next_run = 1;
      }
      else if (parse_int(positional_args[0], &options->run_number) != 0) {
        fprintf(stderr, "Invalid run number: %s\n", positional_args[0]);
        return -1;
      }
    }
    if (positional_count > 1 && parse_int(positional_args[1], &options->acq_time_sec) != 0) {
      fprintf(stderr, "Invalid acquisition time: %s\n", positional_args[1]);
      return -1;
    }
    if (positional_count > 2 && parse_int(positional_args[2], &options->count_period_ms) != 0) {
      fprintf(stderr, "Invalid count period: %s\n", positional_args[2]);
      return -1;
    }
  }

  if (options->run_number < 0 && !options->monitor && !options->next_run) {
    printf("Enter run number: ");
    if (scanf("%d", &options->run_number) != 1)
      return -1;
  }

  if (options->acq_time_sec < 1 || options->count_period_ms < 1) {
    fprintf(stderr, "Acquisition time and count period must be positive.\n");
    return -1;
  }

  return 0;
}

static void update_max_run_number(int candidate, int *max_run_number)
{
  if (candidate > *max_run_number)
    *max_run_number = candidate;
}

static void scan_run_numbers_in_dir(const char *path, int *max_run_number)
{
  DIR *dir;
  struct dirent *entry;
  int run_number;
  char suffix;

  dir = opendir(path);
  if (dir == NULL) {
    if (errno != ENOENT)
      perror(path);
    return;
  }

  while ((entry = readdir(dir)) != NULL) {
    if (sscanf(entry->d_name, "run_%d%c", &run_number, &suffix) == 1) {
      update_max_run_number(run_number, max_run_number);
      continue;
    }
    if (sscanf(entry->d_name, "counter_%d.dat%c", &run_number, &suffix) == 1 ||
        sscanf(entry->d_name, "counter_%d.txt%c", &run_number, &suffix) == 1 ||
        sscanf(entry->d_name, "time_stamp_%d.dat%c", &run_number, &suffix) == 1 ||
        sscanf(entry->d_name, "time_stamp_%d.txt%c", &run_number, &suffix) == 1)
      update_max_run_number(run_number, max_run_number);
  }

  closedir(dir);
}

static int select_next_run_number(const char *data_dir, const char *converted_dir)
{
  int max_run_number = -1;

  scan_run_numbers_in_dir(data_dir, &max_run_number);
  scan_run_numbers_in_dir(converted_dir, &max_run_number);

  return max_run_number + 1;
}

static int ensure_directory(const char *path)
{
  if (mkdir(path, 0775) == 0)
    return 0;

  if (errno == EEXIST)
    return 0;

  perror(path);
  return -1;
}

static FILE *open_default_setup(void)
{
  const char *paths[] = {"setup.txt", "run/setup.txt", "test/setup.txt"};
  size_t i;
  FILE *fp;

  for (i = 0; i < sizeof(paths) / sizeof(paths[0]); ++i) {
    fp = fopen(paths[i], "rt");
    if (fp != NULL) {
      printf("Using setup file: %s\n", paths[i]);
      return fp;
    }
  }

  return NULL;
}

static int read_setup(const char *path, MteSetup *setup)
{
  FILE *fp;
  int ch;

  fp = path == NULL ? open_default_setup() : fopen(path, "rt");
  if (fp == NULL) {
    fprintf(stderr, "Cannot open setup file%s%s\n", path == NULL ? "" : ": ",
            path == NULL ? "" : path);
    return -1;
  }

  for (ch = 0; ch < NUM_DOWN_SCALE; ++ch) {
    if (fscanf(fp, "%d", &setup->down_scale[ch]) != 1) {
      fprintf(stderr, "Setup file is missing down-scale value %d\n", ch + 1);
      fclose(fp);
      return -1;
    }
    if (setup->down_scale[ch] < 1) {
      fprintf(stderr, "Down-scale for ch%d must be >= 1\n", ch + 17);
      fclose(fp);
      return -1;
    }
  }

  for (ch = 0; ch < NUM_INPUT_TYPES; ++ch) {
    if (fscanf(fp, "%d", &setup->input_type[ch]) != 1) {
      fprintf(stderr, "Setup file is missing input type value %d\n", ch + 1);
      fclose(fp);
      return -1;
    }
    if (setup->input_type[ch] != 0 && setup->input_type[ch] != 1) {
      fprintf(stderr, "Input type for ch%d must be 0 or 1\n", ch + 1);
      fclose(fp);
      return -1;
    }
  }

  fclose(fp);
  return 0;
}

static int scaler_is_initialized(int sid, const MteSetup *setup)
{
  int ch;
  int value;

  for (ch = 0; ch < NUM_DOWN_SCALE; ++ch) {
    value = SCALER_read_DOWN_SCALE(sid, ch + 17);
    if (value != setup->down_scale[ch]) {
      printf("Setup mismatch: ch%d down-scale is %d, expected %d\n",
             ch + 17, value, setup->down_scale[ch]);
      return 0;
    }
  }

  for (ch = 0; ch < NUM_INPUT_TYPES; ++ch) {
    value = SCALER_read_INPUT_TYPE(sid, ch + 1);
    if (value != setup->input_type[ch]) {
      printf("Setup mismatch: ch%d input type is %d, expected %d\n",
             ch + 1, value, setup->input_type[ch]);
      return 0;
    }
  }

  return 1;
}

static void write_setup_to_scaler(int sid, const MteSetup *setup)
{
  int ch;

  for (ch = 0; ch < NUM_DOWN_SCALE; ++ch)
    SCALER_write_DOWN_SCALE(sid, ch + 17, setup->down_scale[ch]);

  for (ch = 0; ch < NUM_INPUT_TYPES; ++ch)
    SCALER_write_INPUT_TYPE(sid, ch + 1, setup->input_type[ch]);
}

static void print_scaler_setup(int sid)
{
  int ch;

  for (ch = 17; ch <= 19; ++ch)
    printf("CH%d down-scale = %d\n", ch, SCALER_read_DOWN_SCALE(sid, ch));

  for (ch = 1; ch <= 20; ++ch)
    printf("CH%d input type = %d\n", ch, SCALER_read_INPUT_TYPE(sid, ch));
}

static double parse_stamp_time(const unsigned char *data)
{
  double time_tag = 0.0;

  time_tag += (double)(data[1] & 0xFF) * 0.000000008;
  time_tag += (double)(data[2] & 0xFF) * 0.000001;
  time_tag += (double)(data[3] & 0xFF) * 0.000001 * 256.0;
  time_tag += (double)(data[4] & 0xFF) * 0.000001 * 256.0 * 256.0;
  time_tag += (double)(data[5] & 0xFF) * 0.000001 * 256.0 * 256.0 * 256.0;
  time_tag += (double)(data[6] & 0xFF) * 0.000001 * 256.0 * 256.0 * 256.0 * 256.0;
  time_tag += (double)(data[7] & 0xFF) * 0.000001 * 256.0 * 256.0 * 256.0 * 256.0 * 256.0;

  return time_tag;
}

static double parse_counter_time(const int32_t *data)
{
  double time_tag = 0.0;

  time_tag += (double)((uint32_t)data[12]) * 0.000000002;
  time_tag += (double)((uint32_t)data[13]) * 0.000001;
  time_tag += (double)((uint32_t)data[14]) * 0.000001 * 256.0 * 256.0 * 256.0 * 256.0;

  return time_tag;
}

static void write_stamp_text(FILE *fp, const unsigned char *data, size_t bytes,
                             unsigned long *events)
{
  size_t offset;

  for (offset = 0; offset + 8 <= bytes; offset += 8) {
    if (fp != NULL)
      fprintf(fp, "%u, %.9lf\n", data[offset] & 0xFF, parse_stamp_time(data + offset));
    ++(*events);
  }
}

static void write_counter_text(FILE *fp, const unsigned char *data, size_t bytes,
                               unsigned long *events, CounterSnapshot *snapshot,
                               CounterStats *stats)
{
  size_t offset;
  int ch;

  for (offset = 0; offset + 64 <= bytes; offset += 64) {
    const int32_t *words = (const int32_t *)(const void *)(data + offset);

    if (fp != NULL) {
      fprintf(fp, "%d, ", words[1]);
      for (ch = 0; ch < NUM_COUNTER_CHANNELS; ++ch)
        fprintf(fp, "%d, ", words[ch + 2]);
      fprintf(fp, "%.9lf\n", parse_counter_time(words));
    }
    ++(*events);

    snapshot->valid = 1;
    snapshot->index = words[1];
    snapshot->time_tag = parse_counter_time(words);
    snapshot->event_count = *events;
    for (ch = 0; ch < NUM_COUNTER_CHANNELS; ++ch) {
      snapshot->count[ch] = words[ch + 2];
      stats->count_sum[ch] += words[ch + 2];
    }
    ++stats->events;
  }
}

static int open_run_files(const RunOptions *options, RunFiles *files)
{
  char path[PATH_BUFFER_SIZE];
  int written;

  memset(files, 0, sizeof(*files));

  if (ensure_directory(options->data_dir) != 0)
    return -1;

  written = snprintf(files->data_run_dir, sizeof(files->data_run_dir), "%s/run_%06d",
                     options->data_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(files->data_run_dir)) {
    fprintf(stderr, "Raw data run directory path is too long.\n");
    return -1;
  }
  if (ensure_directory(files->data_run_dir) != 0)
    return -1;

  if (ensure_directory(options->converted_dir) != 0)
    return -1;

  written = snprintf(files->converted_run_dir, sizeof(files->converted_run_dir), "%s/run_%06d",
                     options->converted_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(files->converted_run_dir)) {
    fprintf(stderr, "Converted data run directory path is too long.\n");
    return -1;
  }
  if (ensure_directory(files->converted_run_dir) != 0)
    return -1;

  written = snprintf(path, sizeof(path), "%s/time_stamp_%d.dat", files->data_run_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(path))
    goto path_too_long;
  files->stamp_dat = fopen(path, "wb");
  if (files->stamp_dat == NULL)
    goto fail;

  written = snprintf(path, sizeof(path), "%s/time_stamp_%d.txt", files->converted_run_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(path))
    goto path_too_long;
  files->stamp_txt = fopen(path, "wt");
  if (files->stamp_txt == NULL)
    goto fail;
  fprintf(files->stamp_txt, "Channel, Time stamp(s)\n");
  fprintf(files->stamp_txt, "-------------------------------\n");

  written = snprintf(path, sizeof(path), "%s/counter_%d.dat", files->data_run_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(path))
    goto path_too_long;
  files->counter_dat = fopen(path, "wb");
  if (files->counter_dat == NULL)
    goto fail;

  written = snprintf(path, sizeof(path), "%s/counter_%d.txt", files->converted_run_dir, options->run_number);
  if (written < 0 || (size_t)written >= sizeof(path))
    goto path_too_long;
  files->counter_txt = fopen(path, "wt");
  if (files->counter_txt == NULL)
    goto fail;
  fprintf(files->counter_txt,
          "index, Ch11, Ch12, Ch13, Ch14, Ch15, Ch16, Ch17, Ch18, Ch19, Ch20, Time(s)\n");
  fprintf(files->counter_txt,
          "-----------------------------------------------------------------------------------\n");

  printf("Writing raw .dat files under %s\n", files->data_run_dir);
  printf("Writing live-converted .txt files under %s\n", files->converted_run_dir);
  return 0;

path_too_long:
  fprintf(stderr, "Output file path is too long.\n");
  if (files->stamp_dat != NULL) {
    fclose(files->stamp_dat);
    files->stamp_dat = NULL;
  }
  if (files->stamp_txt != NULL) {
    fclose(files->stamp_txt);
    files->stamp_txt = NULL;
  }
  if (files->counter_dat != NULL) {
    fclose(files->counter_dat);
    files->counter_dat = NULL;
  }
  if (files->counter_txt != NULL) {
    fclose(files->counter_txt);
    files->counter_txt = NULL;
  }
  return -1;

fail:
  perror(path);
  if (files->stamp_dat != NULL) {
    fclose(files->stamp_dat);
    files->stamp_dat = NULL;
  }
  if (files->stamp_txt != NULL) {
    fclose(files->stamp_txt);
    files->stamp_txt = NULL;
  }
  if (files->counter_dat != NULL) {
    fclose(files->counter_dat);
    files->counter_dat = NULL;
  }
  if (files->counter_txt != NULL) {
    fclose(files->counter_txt);
    files->counter_txt = NULL;
  }
  return -1;
}

static void close_run_files(RunFiles *files)
{
  if (files->stamp_dat != NULL)
    fclose(files->stamp_dat);
  if (files->stamp_txt != NULL)
    fclose(files->stamp_txt);
  if (files->counter_dat != NULL)
    fclose(files->counter_dat);
  if (files->counter_txt != NULL)
    fclose(files->counter_txt);
}

static int read_and_save_stamp_data(int sid, unsigned char *buffer, RunFiles *files)
{
  int data_size = SCALER_read_STAMP_DATA_SIZE(sid);
  size_t bytes;

  if (data_size <= 0)
    return 0;

  bytes = (size_t)data_size * 4U;
  if (bytes > READ_BUFFER_BYTES) {
    fprintf(stderr, "Stamp read is too large for buffer: %zu bytes\n", bytes);
    return -1;
  }

  SCALER_read_STAMP_DATA(sid, data_size, (char *)buffer);
  if (files->stamp_dat != NULL)
    fwrite(buffer, 1, bytes, files->stamp_dat);
  write_stamp_text(files->stamp_txt, buffer, bytes, &files->stamp_events);
  files->stamp_bytes += (unsigned long)bytes;

  return 0;
}

static int read_and_save_counter_data(int sid, unsigned char *buffer, RunFiles *files,
                                      CounterSnapshot *snapshot, CounterStats *stats)
{
  int data_size = SCALER_read_COUNTER_DATA_SIZE(sid);
  size_t bytes;

  if (data_size <= 0)
    return 0;

  bytes = (size_t)data_size * 4U;
  if (bytes > READ_BUFFER_BYTES) {
    fprintf(stderr, "Counter read is too large for buffer: %zu bytes\n", bytes);
    return -1;
  }

  SCALER_read_COUNTER_DATA(sid, data_size, (char *)buffer);
  if (files->counter_dat != NULL)
    fwrite(buffer, 1, bytes, files->counter_dat);
  write_counter_text(files->counter_txt, buffer, bytes, &files->counter_events, snapshot, stats);
  files->counter_bytes += (unsigned long)bytes;

  return 0;
}

static int drain_scaler_data(int sid, unsigned char *buffer, RunFiles *files,
                             CounterSnapshot *snapshot, CounterStats *stats)
{
  if (read_and_save_stamp_data(sid, buffer, files) != 0)
    return -1;
  if (read_and_save_counter_data(sid, buffer, files, snapshot, stats) != 0)
    return -1;
  if (files->stamp_dat != NULL)
    fflush(files->stamp_dat);
  if (files->stamp_txt != NULL)
    fflush(files->stamp_txt);
  if (files->counter_dat != NULL)
    fflush(files->counter_dat);
  if (files->counter_txt != NULL)
    fflush(files->counter_txt);
  return 0;
}

static void print_separator(void)
{
  int i;

  for (i = 0; i < COUNTER_TABLE_WIDTH; ++i)
    putchar('-');
  putchar('\n');
}

static void print_counter_header(void)
{
  int ch;

  print_separator();
  printf("%6s %8s %10s", "event#", "time(s)", "#timestamp");
  for (ch = 0; ch < NUM_COUNTER_CHANNELS; ++ch)
    printf(" %8d", ch + 11);
  printf("\n");
  print_separator();
}

static void print_counter_snapshot(const CounterSnapshot *snapshot,
                                   const RunFiles *files)
{
  int ch;

  if (!snapshot->valid) {
    printf("%6lu %8s %10lu  waiting for counter data...\n",
           files->counter_events, "-", files->stamp_events);
    return;
  }

  printf("%6lu %8.3g %10lu",
         files->counter_events, snapshot->time_tag, files->stamp_events);
  for (ch = 0; ch < NUM_COUNTER_CHANNELS; ++ch)
    printf(" %8d", snapshot->count[ch]);
  printf("\n");
}

static void print_counter_summary(const CounterStats *stats)
{
  int ch;

  print_separator();
  printf("%26s", "== Mean count until now:");
  for (ch = 0; ch < NUM_COUNTER_CHANNELS; ++ch)
    printf(" %8.3g", stats->events == 0 ? 0.0 :
           stats->count_sum[ch] / (double)stats->events);
  printf("\n");
  print_separator();
}

int main(int argc, char **argv)
{
  RunOptions options;
  MteSetup setup;
  RunFiles files;
  CounterSnapshot counter_snapshot;
  CounterStats counter_stats;
  unsigned char *buffer = NULL;
  int scaler_sid[10];
  int scaler_found;
  int sid;
  int run;
  int acquisition_started = 0;
  int parse_status;
  int exit_code = 1;
  time_t last_print_time = 0;
  time_t last_summary_time = 0;
  int printed_header = 0;
  struct sigaction sa;

  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = handle_signal;
  sigemptyset(&sa.sa_mask);
  sa.sa_flags = 0;
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);

  parse_status = parse_options(argc, argv, &options);
  if (parse_status > 0)
    return 0;
  if (parse_status < 0)
    return 1;

  if (options.next_run) {
    options.run_number = select_next_run_number(options.data_dir, options.converted_dir);
    printf("Using next run number: %d\n", options.run_number);
  }

  if (read_setup(options.setup_path, &setup) != 0)
    return 1;

  memset(&files, 0, sizeof(files));
  memset(&counter_snapshot, 0, sizeof(counter_snapshot));
  memset(&counter_stats, 0, sizeof(counter_stats));

  buffer = (unsigned char *)malloc(READ_BUFFER_BYTES);
  if (buffer == NULL) {
    fprintf(stderr, "Cannot allocate read buffer.\n");
    return 1;
  }

  USB3Init();

  scaler_found = USB3Scan_SCALER(scaler_sid);
  if (!scaler_found) {
    fprintf(stderr,
            "No usable SCALER module found. Check USB connection and permissions for VID:PID %04x:%04x.\n",
            SCALER_VENDOR_ID, SCALER_PRODUCT_ID);
    goto cleanup_usb;
  }

  sid = scaler_sid[0];
  printf("SCALER found, sid = %d\n", sid);

  if (SCALER_open(sid) != 0) {
    fprintf(stderr, "Failed to open SCALER sid %d\n", sid);
    goto cleanup_usb;
  }

  if (options.force_init || !scaler_is_initialized(sid, &setup)) {
    printf("Initializing SCALER setup...\n");
    write_setup_to_scaler(sid, &setup);
  }
  else {
    printf("SCALER setup already matches setup file.\n");
  }
  print_scaler_setup(sid);

  SCALER_reset(sid);
  SCALER_write_ACQ_TIME(sid, options.acq_time_sec);
  SCALER_write_COUNT_PERIOD(sid, options.count_period_ms);

  printf("Acquisition time = %d s\n", SCALER_read_ACQ_TIME(sid));
  printf("Counting period = %d ms\n", SCALER_read_COUNT_PERIOD(sid));

  if (options.monitor) {
    printf("Monitor mode: no run number and no output files.\n");
  }
  else if (open_run_files(&options, &files) != 0) {
    goto cleanup_scaler;
  }

  SCALER_reset(sid);
  printf("Starting acquisition...\n");
  SCALER_start(sid);
  acquisition_started = 1;

  run = SCALER_read_RUN(sid);
  while (run && !signal_interrupted) {
    time_t now;

    if (drain_scaler_data(sid, buffer, &files, &counter_snapshot, &counter_stats) != 0)
      goto cleanup_scaler;

    now = time(NULL);
    if (!options.quiet && now != (time_t)-1) {
      if (last_print_time == 0 || now != last_print_time) {
        if (!printed_header) {
          print_counter_header();
          printed_header = 1;
          last_summary_time = now;
        }
        print_counter_snapshot(&counter_snapshot, &files);
        last_print_time = now;
      }
      if (last_summary_time != 0 && now - last_summary_time >= PRINT_INTERVAL_SEC) {
        print_counter_summary(&counter_stats);
        print_counter_header();
        last_summary_time = now;
      }
    }

    usleep(100000);
    run = SCALER_read_RUN(sid);
  }

  if (signal_interrupted) {
    printf("Interrupt received, stopping acquisition...\n");
    SCALER_stop(sid);
    acquisition_started = 0;
    usleep(100000);
    printf("Draining remaining data...\n");
  }
  else {
    acquisition_started = 0;
    printf("Acquisition finished, draining remaining data...\n");
  }

  if (drain_scaler_data(sid, buffer, &files, &counter_snapshot, &counter_stats) != 0)
    goto cleanup_scaler;

  if (options.monitor) {
    printf("Read %lu counter bytes and %lu timestamp bytes in monitor mode.\n",
           files.counter_bytes, files.stamp_bytes);
    printf("Converted %lu counter events and %lu timestamp events in memory.\n",
           files.counter_events, files.stamp_events);
  }
  else {
    printf("Saved %lu counter bytes and %lu timestamp bytes.\n",
           files.counter_bytes, files.stamp_bytes);
    printf("Converted %lu counter events and %lu timestamp events.\n",
           files.counter_events, files.stamp_events);
  }
  exit_code = 0;

cleanup_scaler:
  if (acquisition_started)
    SCALER_stop(sid);
  SCALER_close(sid);

cleanup_usb:
  USB3Exit();
  free(buffer);
  close_run_files(&files);

  return exit_code;
}
