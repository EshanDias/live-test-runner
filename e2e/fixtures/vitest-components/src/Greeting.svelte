<script lang="ts">
  import { shout } from './text';
  let { name }: { name: string } = $props();
  function greet(n: string) {
    return `Hello ${shout(n)}`;
  }
</script>

<p>{greet(name)}</p>
