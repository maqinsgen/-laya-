#include <dlfcn.h>
#include <libgen.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef char *(*scan_memory_for_image_key_fn)(int pid, const char *ciphertext_hex);
typedef void (*free_string_fn)(void *value);

static void print_json_string(const char *value) {
    const unsigned char *cursor = (const unsigned char *)(value ? value : "unknown error");
    putchar('"');
    while (*cursor) {
        switch (*cursor) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b", stdout); break;
            case '\f': fputs("\\f", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (*cursor < 0x20) printf("\\u%04x", *cursor);
                else putchar(*cursor);
        }
        cursor += 1;
    }
    putchar('"');
}

static int fail_json(const char *error) {
    fputs("{\"success\":false,\"error\":", stdout);
    print_json_string(error);
    fputs("}\n", stdout);
    return 1;
}

int main(int argc, char **argv) {
    if (argc != 3) {
        fprintf(stderr, "Usage: %s <pid> <ciphertext_hex>\n", argv[0]);
        return fail_json("invalid arguments");
    }

    const int pid = atoi(argv[1]);
    const char *ciphertext_hex = argv[2];
    if (pid <= 0 || ciphertext_hex == NULL || strlen(ciphertext_hex) != 32) {
        return fail_json("invalid pid or ciphertext");
    }

    char executable_path[4096];
    uint32_t executable_path_size = sizeof(executable_path);
    if (_NSGetExecutablePath(executable_path, &executable_path_size) != 0) {
        return fail_json("cannot get executable path");
    }

    char library_path[4096];
    if (snprintf(library_path, sizeof(library_path), "%s/libwx_key.dylib", dirname(executable_path)) >= (int)sizeof(library_path)) {
        return fail_json("native library path is too long");
    }

    void *library = dlopen(library_path, RTLD_NOW | RTLD_LOCAL);
    if (library == NULL) {
        const char *detail = dlerror();
        char error[4096];
        snprintf(error, sizeof(error), "dlopen failed: %s", detail ? detail : "unknown error");
        return fail_json(error);
    }

    scan_memory_for_image_key_fn scan =
        (scan_memory_for_image_key_fn)dlsym(library, "ScanMemoryForImageKey");
    free_string_fn free_string = (free_string_fn)dlsym(library, "FreeString");
    if (scan == NULL) {
        dlclose(library);
        return fail_json("symbol not found: ScanMemoryForImageKey");
    }

    char *result = scan(pid, ciphertext_hex);
    if (result == NULL || result[0] == '\0') {
        dlclose(library);
        return fail_json("no key found");
    }

    if (strncmp(result, "ERROR", 5) == 0) {
        fputs("{\"success\":false,\"error\":", stdout);
        print_json_string(result);
        fputs("}\n", stdout);
    } else {
        fputs("{\"success\":true,\"aesKey\":", stdout);
        print_json_string(result);
        fputs("}\n", stdout);
    }

    if (free_string != NULL) free_string(result);
    dlclose(library);
    return 0;
}
