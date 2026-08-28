#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <unistd.h>

static int write_file(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return -1;
  int result = write(fd, "ok", 2);
  close(fd);
  return result;
}

int main(void) {
  assert(write_file("allowed") == 2);
  assert(write_file(".git/denied") == -1);
  assert(write_file("/outside") == -1);
  assert(getenv("HOME") == NULL);
  assert(getenv("AWS_ACCESS_KEY_ID") == NULL);
  assert(getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") == NULL);
  assert(getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI") == NULL);
  assert(getenv("SPROUT_ECS_PROOF_SECRET") == NULL);
  assert(strcmp(getenv("LANG"), "C") == 0);
  assert(open("/proc/self/environ", O_RDONLY) == -1);
  assert(open("/etc/passwd", O_RDONLY) == -1);
  assert(open("/run/secrets/credential", O_RDONLY) == -1);

  for (int fd = 3; fd < 1024; fd++) {
    errno = 0;
    assert(fcntl(fd, F_GETFD) == -1);
    assert(errno == EBADF);
  }

  errno = 0;
  assert(mount(NULL, "/workspace/.git", NULL, MS_REMOUNT, NULL) == -1);
  assert(errno == EPERM);

  /* A private network namespace is necessary but insufficient on its own. The socket may be
     creatable, but it must have no route to caller, metadata, or internet services. */
  int socket_fd = socket(AF_INET, SOCK_STREAM, 0);
  assert(socket_fd >= 0);
  struct sockaddr_in address = {
      .sin_family = AF_INET,
      .sin_port = htons(80),
      .sin_addr = {.s_addr = htonl(0xA9FEA9FE)}, /* 169.254.169.254 */
  };
  assert(connect(socket_fd, (struct sockaddr *)&address, sizeof(address)) == -1);
  close(socket_fd);

  static const char response[] =
      "{\"status\":\"ok\",\"protocol_version\":1,\"changes\":[{\"path\":\"allowed\","
      "\"kind\":\"created\",\"before_sha256\":null,\"after_sha256\":"
      "\"2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df\"}],"
      "\"warnings\":[]}";
  assert(write(STDOUT_FILENO, response, sizeof(response) - 1) == sizeof(response) - 1);
  return 0;
}
