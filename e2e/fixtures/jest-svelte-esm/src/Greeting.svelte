<script>
  import { shout } from './text.js';
  export let name;
  function greet(n) {
    return `Hello ${shout(n)}`;
  }
</script>

<p>{greet(name)}</p>
