#include <stdio.h>

/* Fixed output so the conformance golden is build-independent: exactly the
 * 12 bytes "hello, nano\n". */
int main(void) {
    fputs("hello, nano\n", stdout);
    return 0;
}
